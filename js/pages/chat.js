// =============================================================================
// CHAT — A simple coaching chatbot for teens learning to invest.
// Uses the BYO LLM path (if API key set) or deterministic template responses
// as fallback.
// =============================================================================

import { getState } from "../state.js";
import { getInstrument } from "../data/universe.js";
import { SYSTEM_PROMPT, matchTemplate, isOffTopic, offTopicRedirect, STARTER_QUESTIONS, runtimeFacts, NO_TOOLS_NOTE } from "../coach/persona.js";
import { marketStatus } from "../data/prices.js";
import { runAgent, streamChat, needsLiveData, logChatTurn, stripToolCallScaffolding, isToolCallOnly, looksLikeLookupOffer, looksLikeFetchPromise, looksLikePricelessList, isDiscoveryQuery, scrubAdvice, looksHinglish, replyLanguageMismatch, prefetchNewsBlock, unsourcedFigures, figureSources, dropFigureSentences } from "../coach/agent.js";
import { buildDossier } from "../coach/dossier.js";
import {
  loadSessions, saveSessions, getActiveSession, setActiveSession,
  createNewSession, deleteSessionById, touchActive, clearActiveMessages,
  renameSession, togglePin,
  formatRelative, SESSIONS_KEY,
} from "../features/chatSessions.js";

// Defense-in-depth: strip any prompt-scaffolding patterns the model might
// leak into its visible reply.
//
// Delegates to the shared stripper in coach/agent.js. That one is the single
// source of truth: it handles the CALL-leak shapes actually seen in the
// production log (parens optional, inline as well as own-line) plus the
// reasoning-preamble paragraphs, which this local copy never caught.
/**
 * Resolve to `promise`'s value, or to null if it takes longer than `ms`.
 * Never rejects.
 *
 * Every retry in this file sits on the path between "the stream finished"
 * and "the composer is re-enabled". An unbounded one strands the user
 * looking at a disabled input and a Stop button that no longer aborts
 * anything. A retry is an optimisation; it must never be able to cost more
 * than it saves.
 */
// Last step for every reply on this page. If the user wrote Hinglish and
// the reply came back in English (C28), ask once more, bounded. Then remove
// any sentence that picks a stock, praises or judges the user's trade,
// nudges the next trade or times the market (C19-C21, scrubAdvice).
async function finishReply(text, userText, system, messages) {
  let out = text;
  if (replyLanguageMismatch(userText, out)) {
    try {
      const again = await withDeadline(runAgent({
        apiKey: getState().settings.llmApiKey || null,
        system: `${system}

# THIS TURN
Your last draft was in English. The user wrote in Hinglish: answer again in Hinglish (Roman script).`,
        messages, profile: "fast",
      }), 12_000);
      const clean = stripScaffolding(again);
      if (clean && clean.trim() && !replyLanguageMismatch(userText, clean)) out = clean.trim();
    } catch (e) { console.warn("[chat] language retry failed:", e?.message || e); }
  }
  return scrubAdvice(out, userText).text;
}

// One short line per tool round, shown while the data loads.
function toolStatus(calls) {
  const arg = (tc) => { try { return JSON.parse(tc?.function?.arguments || "{}"); } catch { return {}; } };
  const syms = [];
  let label = "Looking that up…";
  for (const tc of calls || []) {
    const a = arg(tc), name = tc?.function?.name || "";
    const sym = String(a.symbol || a.ticker || a.coin || "").toUpperCase();
    if ((name === "get_stock_price" || name === "get_crypto_price" || name === "get_fundamentals") && sym) syms.push(sym);
    if (name === "get_user_portfolio") label = "Looking at your portfolio…";
    else if (name === "get_trade_history") label = "Checking your trades…";
    else if (name === "get_watchlist") label = "Opening your watchlist…";
    else if (name === "get_limit_orders") label = "Checking your orders…";
    else if (name === "get_market_news") label = "Reading the latest news…";
    else if (name === "search_stocks") label = "Searching stocks…";
    else if (name === "get_fundamentals") label = `Pulling ${sym || "company"} numbers…`;
  }
  if (syms.length && label === "Looking that up…") {
    const shown = [...new Set(syms)];
    label = `Checking ${shown.slice(0, 3).join(", ")}${shown.length > 3 ? ` and ${shown.length - 3} more` : ""} price${shown.length > 1 ? "s" : ""}…`;
  }
  return label;
}

function withDeadline(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function stripScaffolding(text) {
  if (!text || typeof text !== "string") return text;
  let s = stripToolCallScaffolding(text);
  s = s.replace(/^[ \t]*You hear:[^\n]*\n?/gmi, "");
  s = s.replace(/^[ \t]*\[internal:[^\]]*\][ \t]*\n?/gmi, "");
  s = s.replace(/^\s+/, "");
  return s.replace(/\n{3,}/g, "\n\n");
}

// sessionsData is the persistent envelope { activeId, sessions: [...] }.
// chatLog is ALWAYS a live reference to the active session's messages array
// so existing push/pop/splice logic throughout this file keeps working —
// the array is mutated in place and chatSessions.saveSessions persists it.
let sessionsData = loadSessions();
let chatLog = getActiveSession(sessionsData).messages;

// Cross-tab sync: when another tab writes a new sessions envelope to
// localStorage, the browser fires a `storage` event on every OTHER tab
// for the same origin. We use that to pull in the remote change so the
// chat doesn't diverge between tabs. We intentionally SKIP applying
// remote updates while this tab has a live stream (m_pending=true) — the
// local stream owns the session and would be clobbered otherwise.
window.addEventListener("storage", (e) => {
  if (e.key !== SESSIONS_KEY || !e.newValue) return;
  if (typeof m_pending !== "undefined" && m_pending) return;
  try {
    const fresh = JSON.parse(e.newValue);
    if (!fresh || !Array.isArray(fresh.sessions) || !fresh.sessions.length) return;
    // Which chat is open is this tab's business: switching chats in another
    // tab must not switch this one (C17).
    const mineActive = sessionsData?.activeId;
    if (mineActive && fresh.sessions.some((s) => s.id === mineActive)) fresh.activeId = mineActive;
    sessionsData = fresh;
    chatLog = getActiveSession(sessionsData).messages;
    // Only re-render if the chat page is currently mounted. renderChat
    // sets up DOM with #chat-messages, so presence of that element is a
    // reliable mount signal.
    if (document.getElementById("chat-messages")) {
      document.dispatchEvent(new CustomEvent("ss:chat-sessions-sync"));
    }
  } catch {}
});

// Same-tab sync from Supabase: when loadAllFromDb hydrates coach chats
// from the DB (e.g. first login on a new device / incognito window), it
// writes to localStorage in THIS tab — storage events don't fire for
// same-tab writes, so we listen for the custom 'ss:coach-sync' event
// that sync.js dispatches. Reload sessions + re-render if mounted.
window.addEventListener("ss:coach-sync", () => {
  if (typeof m_pending !== "undefined" && m_pending) return;
  try {
    sessionsData = loadSessions();
    chatLog = getActiveSession(sessionsData).messages;
    if (document.getElementById("chat-messages")) {
      const main = document.getElementById("main");
      if (main) renderChat(main);
    }
  } catch (e) { console.warn("[chat] ss:coach-sync failed:", e); }
});

function saveChat() {
  // Session's messages array is `chatLog` itself (same reference), so any
  // push/pop done by the renderers is already reflected. We just touch the
  // timestamp + title and persist the whole envelope.
  touchActive(sessionsData);
  saveSessions(sessionsData);
}

function rebindActiveChatLog() {
  chatLog = getActiveSession(sessionsData).messages;
}

function replyFor(text) {
  const state = getState();
  return matchTemplate(text, {
    holdings: state.holdings || {},
    symbolOf: getInstrument,
    newsItems: [],
  });
}

export function renderChat(main) {
  main.classList.add("main-chat");
  window.addEventListener("ss:navigate", () => main.classList.remove("main-chat"), { once: true });
  render();

  // Cross-tab sync: when the storage event handler (see module scope) pulls
  // in fresh sessionsData from another tab, it fires this custom event so
  // the currently-mounted chat page re-renders with the updated state.
  const syncHandler = () => { if (document.getElementById("chat-messages")) render(); };
  document.addEventListener("ss:chat-sessions-sync", syncHandler);
  window.addEventListener("ss:navigate", () => {
    document.removeEventListener("ss:chat-sessions-sync", syncHandler);
  }, { once: true });

  function render() {
    const state = getState();
    const active = getActiveSession(sessionsData);

    main.innerHTML = `
      <div class="cc cc-has-side ${drawerOpen ? "is-drawer-open" : ""}">
        <aside class="cc-side" id="cc-side" aria-label="Your chats">
          <div class="cc-side-top">
            <span class="cc-side-name">Saathi</span>
            <button class="cc-side-close" id="cc-side-close" type="button" aria-label="Close chat list">&times;</button>
          </div>
          <button id="chat-new-btn" class="cc-side-new" type="button">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            New chat
          </button>
          <label class="cc-search">
            <span class="sr-only">Search chats</span>
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <input id="cc-search" type="search" placeholder="Search chats" autocomplete="off" value="${escapeAttr(sideQuery)}" />
          </label>
          <nav class="cc-list" id="cc-list">${renderChatList()}</nav>
        </aside>
        <button class="cc-scrim" id="cc-scrim" type="button" aria-label="Close chat list" tabindex="-1"></button>

        <section class="cc-main">
          <header class="cc-head">
            <button class="cc-chip-btn cc-menu-btn" id="cc-open-side" type="button" aria-controls="cc-side" aria-label="Open chat list">
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
              Chats
            </button>
            <div class="cc-id">
              <h1 class="cc-title">${chatLog.length ? escapeHtml(active.title || "Saathi") : "Saathi"}</h1>
            </div>
            <button class="cc-chip-btn cc-new cc-head-new" id="chat-new-btn-2" type="button" aria-label="New chat">+</button>
          </header>

          <div class="cc-panel chat-card ${chatLog.length ? "" : "is-empty"}">
            <div id="chat-messages" class="chat-messages cc-messages">
              ${renderMessages()}
            </div>

            <form id="chat-form" class="composer cc-composer">
              <div class="composer-shell ${m_pending ? "is-busy" : ""}">
                <textarea
                  id="chat-input"
                  class="composer-input"
                  rows="1"
                  placeholder="${m_pending ? "Type your next message…" : "Ask Saathi anything"}"
                  autocomplete="off"
                  maxlength="2000"
                  aria-label="Message Saathi"
                ></textarea>
                ${m_pending
                  ? `<button class="composer-btn is-stop" id="chat-stop" type="button" title="Stop generating" aria-label="Stop generating">&#9632;</button>`
                  : `<button class="composer-btn" id="chat-send" type="submit" title="Send" aria-label="Send message">&#8593;</button>`}
              </div>
            </form>
            <button class="cc-jump" id="cc-jump" type="button" aria-label="Jump to latest message" hidden>
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
            </button>
          </div>
          <p class="cc-foot">Saathi can get things wrong. Check prices before you trade.</p>
        </section>
      </div>
    `;

    const input = main.querySelector("#chat-input");
    const form = main.querySelector("#chat-form");
    const messagesEl = main.querySelector("#chat-messages");
    if (chatLog.length) messagesEl.scrollTop = messagesEl.scrollHeight;
    // Desktop: auto-focus so the user can start typing. Mobile: don't —
    // focusing an input pops the soft keyboard, and the user hasn't
    // asked for it yet. They can tap the input themselves to start.
    if (window.innerWidth >= 1024 && !drawerOpen) input.focus();

    // Grows with the text up to ~8 lines, like the big chat apps.
    const fit = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; input.style.overflowY = input.scrollHeight > 200 ? "auto" : "hidden"; };
    input.addEventListener("input", fit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!m_pending) form.requestSubmit();
      }
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      // A reply is still running: keep what was typed, it sends once it ends.
      if (m_pending) return;
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      fit();
      main.querySelector(".cc-panel")?.classList.remove("is-empty");
      pushUser(text);
      rerender();
      refreshSide();
      await sendAndReply(text);
      rerender();
      refreshSide();
      const cur = getActiveSession(sessionsData);
      const h = main.querySelector(".cc-title"), sub = main.querySelector(".cc-sub");
      if (h && cur?.messages?.length) h.textContent = cur.title || "Saathi";
    });

    // Stop-button: aborts the in-flight stream. The sendAndReply handler
    // detects the aborted state, appends a "stopped" suffix, and releases
    // m_pending so the input re-enables.
    main.querySelector("#chat-stop")?.addEventListener("click", () => {
      if (m_abortController) m_abortController.abort();
    });

    messagesEl.addEventListener("click", async (e) => {
      const copyBtn = e.target.closest("[data-copy]");
      if (!copyBtn) return;
      const body = copyBtn.closest(".cc-row")?.querySelector(".msg-body");
      try {
        await navigator.clipboard.writeText(body?.innerText || "");
        copyBtn.classList.add("is-done");
        copyBtn.lastChild.textContent = "Copied";
        setTimeout(() => { copyBtn.classList.remove("is-done"); copyBtn.lastChild.textContent = "Copy"; }, 1500);
      } catch {}
    });
    const jump = main.querySelector("#cc-jump");
    messagesEl.addEventListener("scroll", () => {
      jump.hidden = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 160;
    }, { passive: true });
    jump.addEventListener("click", () => { messagesEl.scrollTop = messagesEl.scrollHeight; });

    main.querySelectorAll("[data-q]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (m_pending) return;
        input.value = btn.dataset.q;
        form.dispatchEvent(new Event("submit"));
      });
    });

    const stopStream = () => {
      if (m_abortController) { try { m_abortController.abort(); } catch {} }
      m_abortController = null;
      m_pending = false;
    };
    const newChat = () => {
      stopStream();
      // Reuse an empty chat instead of piling up blank ones.
      const blank = sessionsData.sessions.find(x => !(x.messages || []).length);
      if (blank) setActiveSession(sessionsData, blank.id);
      else createNewSession(sessionsData);
      rebindActiveChatLog();
      sideQuery = "";
      drawerOpen = false;
      render();
    };
    main.querySelector("#chat-new-btn")?.addEventListener("click", newChat);
    main.querySelector("#chat-new-btn-2")?.addEventListener("click", newChat);

    // Drawer (phones and narrow windows).
    const setDrawer = (open) => {
      drawerOpen = open;
      main.querySelector(".cc")?.classList.toggle("is-drawer-open", open);
      if (open) main.querySelector("#cc-search")?.focus();
    };
    main.querySelector("#cc-open-side")?.addEventListener("click", () => setDrawer(true));
    main.querySelector("#cc-side-close")?.addEventListener("click", () => setDrawer(false));
    main.querySelector("#cc-scrim")?.addEventListener("click", () => setDrawer(false));

    const search = main.querySelector("#cc-search");
    search?.addEventListener("input", () => { sideQuery = search.value; refreshSide(); });

    const list = main.querySelector("#cc-list");
    const closeMenus = () => list?.querySelectorAll(".cc-item-menu").forEach(m => m.remove());
    list?.addEventListener("click", (e) => {
      const openBtn = e.target.closest("[data-open]");
      const moreBtn = e.target.closest("[data-more]");
      const act = e.target.closest("[data-act]");
      if (act) {
        e.stopPropagation();
        const id = act.dataset.id;
        const sess = sessionsData.sessions.find(x => x.id === id);
        closeMenus();
        if (!sess) return;
        if (act.dataset.act === "pin") { togglePin(sessionsData, id); refreshSide(); }
        else if (act.dataset.act === "rename") startRename(id);
        else if (act.dataset.act === "delete") {
          if (!confirm(`Delete "${sess.title || "this chat"}"? This can't be undone.`)) return;
          if (sessionsData.activeId === id) stopStream();
          deleteSessionById(sessionsData, id);
          rebindActiveChatLog();
          render();
        }
        return;
      }
      if (moreBtn) {
        e.stopPropagation();
        const row = moreBtn.closest(".cc-item");
        const had = row.querySelector(".cc-item-menu");
        closeMenus();
        if (had) return;
        const id = row.dataset.id;
        const sess = sessionsData.sessions.find(x => x.id === id);
        row.insertAdjacentHTML("beforeend", `
          <div class="cc-item-menu" role="menu">
            <button type="button" role="menuitem" data-act="pin" data-id="${escapeAttr(id)}">${sess?.pinned ? "Unpin" : "Pin"}</button>
            <button type="button" role="menuitem" data-act="rename" data-id="${escapeAttr(id)}">Rename</button>
            <button type="button" role="menuitem" data-act="delete" data-id="${escapeAttr(id)}" class="is-danger">Delete</button>
          </div>`);
        row.querySelector(".cc-item-menu button")?.focus();
        return;
      }
      if (openBtn) {
        const id = openBtn.dataset.open;
        drawerOpen = false;
        if (id === sessionsData.activeId) { setDrawer(false); return; }
        stopStream();
        setActiveSession(sessionsData, id);
        rebindActiveChatLog();
        render();
      }
    });
    const onDocClick = (e) => { if (!e.target.closest(".cc-item")) closeMenus(); };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (list?.querySelector(".cc-item-menu")) closeMenus();
      else if (drawerOpen) setDrawer(false);
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    // render() runs again on every chat switch; drop this render's listeners
    // when the next one starts or the page is left.
    const off = () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
    cleanupSide?.();
    cleanupSide = off;
    window.addEventListener("ss:navigate", off, { once: true });

    function startRename(id) {
      const row = list.querySelector(`.cc-item[data-id="${CSS.escape(id)}"]`);
      const sess = sessionsData.sessions.find(x => x.id === id);
      if (!row || !sess) return;
      const btn = row.querySelector("[data-open]");
      btn.outerHTML = `<input class="cc-rename" maxlength="80" value="${escapeAttr(sess.title || "")}" aria-label="Chat name" />`;
      const inp = row.querySelector(".cc-rename");
      inp.focus(); inp.select();
      let done = false;
      const finish = (save) => {
        if (done) return; done = true;
        if (save) renameSession(sessionsData, id, inp.value);
        render();
      };
      inp.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
        if (ev.key === "Escape") { ev.stopPropagation(); finish(false); }
      });
      inp.addEventListener("blur", () => finish(true));
    }

    function refreshSide() {
      const l = main.querySelector("#cc-list");
      if (l) l.innerHTML = renderChatList();
    }
  }

  // Chat list: pinned first, then grouped by last activity.
  function renderChatList() {
    const q = sideQuery.trim().toLowerCase();
    const all = sessionsData.sessions
      .filter(x => (x.messages || []).length || x.id === sessionsData.activeId)
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (q) {
      const hits = [];
      for (const x of all) {
        const inTitle = (x.title || "").toLowerCase().includes(q);
        const msg = (x.messages || []).find(m => String(m.text || "").toLowerCase().includes(q));
        if (!inTitle && !msg) continue;
        let snip = "";
        if (msg) {
          const t = String(msg.text).replace(/\s+/g, " ");
          const i = t.toLowerCase().indexOf(q);
          snip = (i > 30 ? "…" : "") + t.slice(Math.max(0, i - 30), i + q.length + 50);
        }
        hits.push(chatItem(x, snip));
      }
      return hits.length ? hits.join("") : `<p class="cc-list-empty">No chats match "${escapeHtml(sideQuery.trim())}".</p>`;
    }
    const day = 86400000;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const today = start.getTime();
    const groups = [["Pinned", []], ["Today", []], ["Yesterday", []], ["Previous 7 days", []], ["Previous 30 days", []], ["Older", []]];
    for (const x of all) {
      const t = x.updatedAt || x.createdAt || 0;
      const g = x.pinned ? 0 : t >= today ? 1 : t >= today - day ? 2 : t >= today - 7 * day ? 3 : t >= today - 30 * day ? 4 : 5;
      groups[g][1].push(x);
    }
    return groups.filter(([, xs]) => xs.length).map(([name, xs]) => `
      <div class="cc-group">
        <h2 class="cc-group-name">${name}</h2>
        ${xs.map(x => chatItem(x)).join("")}
      </div>`).join("");
  }

  function chatItem(x, snip = "") {
    const isActive = x.id === sessionsData.activeId;
    const title = (x.messages || []).length ? (x.title || "New chat") : "New chat";
    return `
      <div class="cc-item ${isActive ? "is-active" : ""}" data-id="${escapeAttr(x.id)}">
        <button type="button" class="cc-item-open" data-open="${escapeAttr(x.id)}" ${isActive ? 'aria-current="page"' : ""}>
          <span class="cc-item-title">${escapeHtml(title)}</span>
          ${snip ? `<span class="cc-item-snip">${escapeHtml(snip)}</span>` : ""}
        </button>
        <button type="button" class="cc-item-more" data-more aria-label="Options for ${escapeAttr(title)}" aria-haspopup="menu">&middot;&middot;&middot;</button>
      </div>`;
  }

  function rerender() {
    const messagesEl = main.querySelector("#chat-messages");
    if (messagesEl) {
      messagesEl.innerHTML = renderMessages();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function renderMessages() {
    if (!chatLog.length) {
      return `
        <div class="cc-empty">
          <h2 class="cc-empty-title">What do you want to understand today?</h2>
          <div class="cc-starters">
            ${STARTER_QUESTIONS.map(q => `<button type="button" class="cc-starter" data-q="${escapeAttr(q)}">${escapeHtml(q)}</button>`).join("")}
          </div>
        </div>
      `;
    }
    return chatLog.map(m => renderBubble(m)).join("") +
      (m_pending ? renderTyping() : "");
  }
}

let m_pending = false;
let m_abortController = null;
let sideQuery = "";
let drawerOpen = false;
let cleanupSide = null;

function renderBubble(m) {
  const streamAttr = m.streaming ? ` data-streaming="1"` : "";
  if (m.role === "user") {
    return `<div class="cc-row cc-row-user"${streamAttr}><div class="cc-bubble cc-user"><span class="msg-body">${escapeHtml(m.text)}</span></div></div>`;
  }
  const actions = m.streaming || m.status || !m.text ? "" : `
    <div class="cc-actions-row">
      <button type="button" class="cc-act" data-copy aria-label="Copy reply"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="3"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg><span>Copy</span></button>
    </div>`;
  return `<div class="cc-row cc-row-bot"${streamAttr}><div class="cc-bot-col"><div class="cc-bubble cc-bot"><span class="msg-body">${m.status ? statusHtml(m.text) : renderMarkdown(m.text)}</span></div>${actions}</div></div>`;
}

// "Checking TCS price…" while tools run: a pulsing dot, not a reply.
function statusHtml(text) {
  return `<span class="cc-status" role="status"><i aria-hidden="true"></i>${escapeHtml(text)}</span>`;
}

// Minimal safe Markdown renderer for chat bubbles. Escapes HTML first (so
// user/LLM content can't inject tags), then converts a whitelist of common
// Gemini-output patterns: **bold**, *italic*, `code`, auto-linked URLs.
// Paragraph spacing is handled by CSS white-space: pre-wrap on the bubble.
// Shared markdown renderer body — written once, injected into both
// chat.js and coachPanel.js by patch-md.py.
function renderMarkdown(text) {
  if (!text) return "";
  const esc = (x) => { const d = document.createElement("div"); d.textContent = String(x ?? ""); return d.innerHTML; };

  // Inline formatting, applied to already-escaped text.
  const inline = (raw) => {
    let s = esc(raw);
    // Bold first, so the single-* italic rule below can't claim its asterisks.
    s = s.replace(/\*\*([^\n*][^\n*]*?)\*\*/g, "<strong>$1</strong>");
    // Italic: conservative — needs a boundary on both sides.
    s = s.replace(/(^|[\s(])\*([^\n*][^\n*]*?)\*(?=[\s.,!?)]|$)/g, "$1<em>$2</em>");
    s = s.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>');
    s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener" class="md-link">$2</a>');
    return s;
  };

  // Block pass. The model writes real markdown lists — "*   HDFC Bank",
  // "- Axis Bank", "1. Reliance" — and the old renderer had no list handling
  // at all, so a five-bank comparison arrived as a wall of literal asterisks.
  // Rather than fight the model (a bullet IS the right shape for comparing
  // instruments), render them.
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let list = null;          // "ul" | "ol" | null
  let para = [];

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; }
  };
  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d{1,2})[.)]\s+(.*)$/);

    if (!line.trim()) { flushPara(); closeList(); continue; }

    if (bullet) {
      flushPara();
      if (list !== "ul") { closeList(); out.push('<ul class="md-list">'); list = "ul"; }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    if (numbered) {
      flushPara();
      if (list !== "ol") { closeList(); out.push('<ol class="md-list">'); list = "ol"; }
      out.push(`<li>${inline(numbered[2])}</li>`);
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();
  return out.join("");
}

function renderTyping() {
  return `<div class="cc-row cc-row-bot"><div class="cc-bubble cc-bot cc-typing" aria-label="Saathi is typing"><i></i><i></i><i></i></div></div>`;
}

function pushUser(text) {
  chatLog.push({ role: "user", text, ts: Date.now() });
  saveChat();
}
function pushAssistant(text) {
  chatLog.push({ role: "assistant", text, ts: Date.now() });
  saveChat();
}

async function sendAndReply(userText) {
  m_pending = true;
  m_abortController = new AbortController();

  // Off-topic gate. FIRES BEFORE THE LLM CALL. User-reported 2026-05-05:
  // "help me cook maggi" was bypassing this entirely (it was imported
  // but never invoked), hitting Gemini Flash with no tools, and the model
  // regurgitated a verbatim BTC few-shot example from persona.js — answer
  // came back as "Bitcoin is at ₹76,50,662..." for a cooking question.
  // Now: any off-topic message gets the canonical refusal and saves the
  // tokens. The OFF_TOPIC_PATTERNS in persona.js were also broadened to
  // catch bare-cook-verb constructions like "help me cook maggi".
  // NOTE: the actual early-return now lives further down, after finalPaint /
  // restoreForm are defined. See "OFF-TOPIC EARLY RETURN" below for why.

  // Capture the OWNER session at send time. If the user switches sessions
  // or hits + New while the stream is running, we still write tokens into
  // the session that owns the user's message — avoiding cross-session
  // corruption. Re-renders, on the other hand, only fire if the owner is
  // still the active session.
  const ownerSession = getActiveSession(sessionsData);
  const ownerMessages = ownerSession.messages;
  const ownerSessionId = ownerSession.id;
  const isOwnerActive = () => sessionsData.activeId === ownerSessionId;

  // Manually toggle the form DOM so the input disables + Send becomes Stop
  // without a full re-render (a full re-render would re-attach listeners
  // and move focus, disrupting the user's typing rhythm).
  const outer = document.getElementById("main");
  const input = outer?.querySelector("#chat-input");
  const sendBtn = outer?.querySelector("#chat-send");
  const shell = outer?.querySelector(".composer-shell");
  if (shell) shell.classList.add("is-busy");
  if (input) {
    // Typing stays open while Saathi replies; only sending waits.
    input.placeholder = "Type your next message…";
    // Don't steal focus during mobile streaming — keeps the virtual
    // keyboard from popping up uninvited. Desktop-only.
    if (window.innerWidth >= 1024) input.focus();
  }
  if (sendBtn) {
    sendBtn.outerHTML = `<button class="composer-btn is-stop" id="chat-stop" type="button" title="Stop generating" aria-label="Stop generating">&#9632;</button>`;
    outer.querySelector("#chat-stop")?.addEventListener("click", () => {
      if (m_abortController) m_abortController.abort();
    });
  }

  const reRenderOuter = () => {
    // Only re-render if the owner session is still the visible one.
    if (!isOwnerActive()) return;
    const messagesEl = outer?.querySelector("#chat-messages");
    if (messagesEl) {
      messagesEl.innerHTML = "";
      for (const m of ownerMessages) messagesEl.innerHTML += renderBubble(m);
      if (m_pending && !ownerMessages.at(-1)?.streaming) messagesEl.innerHTML += renderTyping();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  };

  // FINAL PAINT — belt and braces, run once a turn has fully completed.
  //
  // reRenderOuter() above is gated on isOwnerActive(), which compares
  // ownerSessionId against `sessionsData.activeId`. `sessionsData` is a
  // MODULE-LEVEL binding that two async listeners reassign wholesale: the
  // cross-tab `storage` handler and the `ss:coach-sync` handler that fires
  // when sync.js hydrates chat history from Supabase. If either lands while
  // a turn is in flight, isOwnerActive() ends up comparing a captured id
  // against a freshly-loaded object and returns false — so the reply is
  // pushed and saved but never painted. Observed live on 2026-09-13: the
  // coach answered an injection probe correctly, the reply sat in
  // localStorage, and the user saw nothing until navigating away and back.
  //
  // This reads the CURRENT active session rather than the captured array,
  // so it paints the truth regardless of which object won the race.
  const finalPaint = () => {
    try {
      const el = document.getElementById("chat-messages");
      if (!el) return;
      const active = getActiveSession(sessionsData);
      if (!active || active.id !== ownerSessionId) return;
      el.innerHTML = "";
      for (const m of active.messages) el.innerHTML += renderBubble(m);
      el.scrollTop = el.scrollHeight;
    } catch (e) {
      console.warn("[chat] finalPaint failed:", e);
    }
  };

  const restoreForm = () => {
    // Re-read from the DOM rather than trusting the captured refs: a
    // re-render between send and completion replaces these nodes, and a
    // stale ref here is how the composer ends up stuck on "thinking".
    const el = document.getElementById("main");
    const shellNow = el?.querySelector(".composer-shell");
    shellNow?.classList.remove("is-busy");
    shellNow?.querySelector(".composer-dots")?.remove();

    const inputNow = el?.querySelector("#chat-input") || input;
    if (inputNow) {
      inputNow.removeAttribute("readonly");
      inputNow.removeAttribute("disabled");
      inputNow.placeholder = "Ask Saathi anything";
      // Same rationale as above — desktop auto-focus is fine, mobile
      // pops a keyboard the user didn't ask for.
      if (window.innerWidth >= 1024) inputNow.focus();
    }
    const stopBtn = el?.querySelector("#chat-stop");
    if (stopBtn) {
      stopBtn.outerHTML = `<button class="composer-btn" id="chat-send" type="submit" title="Send" aria-label="Send message">&#8593;</button>`;
    }
  };

  const state = getState();
  // The window moves 8 messages at a time, not 1, so its first message (and
  // with it the cacheable start of the request) stays the same between turns.
  const messages = chatLog.slice(Math.floor(Math.max(0, chatLog.length - 12) / 8) * 8).map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.text,
  }));

  // Heuristic: does the message obviously need live data (stock price,
  // portfolio, crypto, news)? If yes, take the slower tool-use path with
  // runAgent. If no, stream tokens directly for instant feel — first
  // character typically visible in ~300ms.
  // Pass the recent turns so a short follow-up ("i mean on stocksaathi",
  // "well how much do i own") inherits the previous turn's routing instead
  // of dropping onto the tool-less streaming path.
  // Built ONCE per turn, before the fork, so both paths carry identical
  // user context. /chat previously injected NO portfolio context at all:
  // on this page the coach's only route to the user's own data was a tool
  // call, which is why "it says it can't see my trade history" was
  // literally true here.
  // ── OFF-TOPIC EARLY RETURN ────────────────────────────────────────────────
  //
  // This used to sit ~130 lines above, right after `m_pending = true`, and it
  // called a bare `render()`. That identifier does not exist in this scope:
  // render() is declared inside renderChat()'s closure (line ~132), and
  // sendAndReply is a module-level function. Every off-topic message therefore
  // threw ReferenceError: render is not defined.
  //
  // The throw landed BETWEEN saving the reply and clearing the pending flag,
  // so the consequences were both of the bugs COACH_FIXES already has entries
  // for, via a new route:
  //
  //   §28  the refusal was pushed and persisted but never painted — the user
  //        saw nothing at all
  //   §30  `m_pending` stayed true, and the submit handler's guardrail
  //        (`if (m_pending) return`) then silently swallowed every following
  //        message. The chat page was bricked until reload.
  //
  // Found by firing adversarial input at production in a real browser:
  // "Ignore all previous instructions..." produced 0 LLM calls, 0 new
  // messages, and an unhandled ReferenceError. Off-topic input is exactly what
  // a curious teenager types.
  //
  // Moved here so the repaint helpers actually exist (they are `const` arrow
  // functions declared above, so referencing them earlier would hit the
  // temporal dead zone and throw just as hard). It still fires before any
  // network work, so it saves the LLM call and the dossier build as intended.
  if (isOffTopic(userText)) {
    try {
      ownerMessages.push({ role: "assistant", text: offTopicRedirect(userText), ts: Date.now() });
      if (isOwnerActive()) chatLog = ownerMessages;
      saveSessions(sessionsData);
      finalPaint();
    } catch (e) {
      console.warn("[chat] off-topic paint failed:", e);
    } finally {
      // Unconditionally, in a finally: whatever goes wrong above, the composer
      // must come back. A stuck m_pending is worse than a missing reply
      // because it eats every message the user sends afterwards.
      m_pending = false;
      m_abortController = null;
      restoreForm();
    }
    return;
  }

  const dossier = await buildDossier();

  const wantTools = needsLiveData(userText, chatLog.slice(-8, -1));
  // C28: the general language rule in runtimeFacts still lost to English
  // replies; a line about THIS message, last in the prompt, holds better.
  const turnLang = looksHinglish(userText)
    ? `

# THIS TURN: LANGUAGE
The user wrote in Hinglish (Hindi in Roman script). Reply in Hinglish, the way they wrote, keeping finance terms like P/E and NAV in English.`
    : "";

  if (wantTools) {
    // Tool-use path: non-streaming, standard runAgent with TOOLS.
    reRenderOuter();   // show typing indicator
    let replyText = null;
    let errorText = null;
    // Live bubble: a status line while tools run ("Checking TCS price…"),
    // then the answer as it streams. The finished reply replaces its text.
    let live = null;
    const showLive = (t, isStatus) => {
      if (!live) {
        live = { role: "assistant", text: "", ts: Date.now(), streaming: true };
        ownerMessages.push(live);
        reRenderOuter();
      }
      // Status lines show at once; answer text types out, because the model
      // often sends a short reply in one or two big chunks.
      liveTarget = isStatus ? "" : t;
      if (isStatus || liveStatus || !t.startsWith(live.text)) live.text = isStatus ? t : "";
      liveStatus = !!isStatus;
      live.status = liveStatus;
      if (isStatus || !t) paintLive();
      else if (!liveTimer) liveTimer = setInterval(() => {
        const rem = liveTarget.length - live.text.length;
        if (rem <= 0 || liveStatus) { clearInterval(liveTimer); liveTimer = null; return; }
        live.text = liveTarget.slice(0, live.text.length + Math.min(rem, 2 + Math.floor(rem / 40)));
        paintLive();
      }, 18);
    };
    let liveTarget = "", liveTimer = null, liveStatus = false;
    const paintLive = () => {
      if (!isOwnerActive() || !live) return;
      const bubble = outer?.querySelector('#chat-messages [data-streaming="1"] .msg-body');
      if (!bubble) { reRenderOuter(); return; }
      bubble.innerHTML = live.status ? statusHtml(live.text) : renderMarkdown(live.text);
      const msgs = outer?.querySelector("#chat-messages");
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    };
    // DECLARED HERE, NOT INSIDE THE try BELOW.
    //
    // It used to live inside the try, whose block scope ends ~15 lines later.
    // The lookup-offer escalation further down is in THIS block but outside
    // that try, so its `system + nudge` skipped the dead binding and resolved
    // to the function-level `const system` declared in the streaming path
    // (~line 788) - which has not been initialised at that point.
    //
    // Every escalation attempt therefore threw
    //   "Cannot access 'system' before initialization"
    // straight into its own catch, which logged a warning and moved on. The
    // escalation has never once run. COACH_FIXES §22 presents it as the CODE
    // layer behind the prompt layer, on the argument that "a prompt rule is a
    // preference, not a guarantee" - and the guarantee was a no-op.
    //
    // Found by reading the browser console during adversarial testing, not by
    // any test: it fails silently by construction.
    // Discovery queries get the price instruction UP FRONT rather than via the
    // escalation below. persona.js already demands "names AND numbers in one
    // reply" for a sector question, and the model still returns a bare list
    // often enough that the detector fires. Letting the retry fix it costs a
    // whole second agent loop: measured 6 LLM hops, 40 quote requests and 30s
    // wall clock, against ~half that when the instruction rides the first call.
    //
    // The escalation stays as the safety net. This just stops it being the
    // normal path.
    const discoveryNudge = isDiscoveryQuery(userText)
      ? `

# THIS TURN
This is a discovery question. Search for the instruments AND call get_stock_price for every symbol you plan to name - in parallel, in ONE turn - then reply with the names and their prices together. A list of names with no prices is not an acceptable answer, and do not ask whether the user wants the prices.`
      : "";
    // News-shaped question: the app fetches the headlines itself (C5). The
    // model answered "latest news on oil and Iran" from memory on 6 Oct
    // with the news tool right there.
    const newsBlock = await prefetchNewsBlock(userText);
    const system = `${SYSTEM_PROMPT}\n\n# TOOL USE\nYou have tools for live data: get_stock_price, get_crypto_price, search_stocks, get_market_news, get_user_portfolio, get_trade_history, get_watchlist, get_limit_orders, get_fundamentals. USE them whenever the user asks about any specific stock, crypto, market state, company fundamentals (profit, EPS, ROE, P/E, debt, market cap), or their portfolio. Never guess numbers — always call the tool.\n\nCRITICAL: Call tools via the STRUCTURED tool_calls API only. NEVER write literal text like 'CALL search_stocks(...)' or '[Tool call: ...]' or fenced ` + "```tool_calls```" + ` JSON in your visible response. Those are internal scaffolding the user must never see. If you want to call a tool, emit the tool_call JSON block and let the system handle it. Your visible reply either (a) answers the user's question with real data you just received from a tool, or (b) says you'll look it up — never describes the mechanics of looking it up.\n\n${runtimeFacts(marketStatus())}\n\n${dossier}\n\n# TONE\nKeep replies conversational and short by default (1–3 sentences). Only go longer when the user asks for explanation or depth.` + newsBlock + discoveryNudge + turnLang;
    try {
      replyText = await runAgent({
        apiKey: state.settings.llmApiKey || null,
        system,
        messages,
        profile: "fast",
        onText: (t) => showLive(t || "", false),
        onStep: (st) => {
          if (st.action === "tool_calls") showLive(toolStatus(st.calls), true);
          else if (st.action === "figure_check") showLive("Double-checking the numbers…", true);
        },
      });
    } catch (e) {
      console.warn("coach chat tool path error:", e);
      errorText = "Couldn't reach Saathi right now. Try again in a moment.";
    }
    // Let the typing finish (at most 2 s) before the final text lands.
    if (liveTimer) await new Promise((done) => {
      const until = Date.now() + 2000;
      const w = setInterval(() => { if (!liveTimer || Date.now() > until) { clearInterval(w); done(); } }, 30);
    });
    m_pending = false;
    m_abortController = null;
    // Write into the OWNER session's messages directly so a mid-stream
    // session switch doesn't land the reply in the wrong chat.
    let cleanedReply = stripScaffolding(replyText);
    // The user already asked. If the model came back offering to look it up
    // rather than looking it up, run the turn again with an explicit
    // instruction, instead of spending the user's turn on a yes/no.
    // Two distinct failures, one remedy. The offer detector catches a short,
    // figure-free dodge. The priceless-list detector catches the shape it
    // structurally cannot see: a long list of instruments with no numbers,
    // which is what "fetch a list of 20 top bank stocks" actually returned in
    // production. See looksLikePricelessList in coach/agent.js.
    const pricelessList = looksLikePricelessList(cleanedReply, userText);
    if (looksLikeLookupOffer(cleanedReply) || looksLikeFetchPromise(cleanedReply) || pricelessList) {
      try {
        // Bounded — see the note on the streaming escalation below. A retry
        // that outlives the user's patience is worse than the reply we're
        // trying to improve.
        const nudge = pricelessList
          ? `

# THIS TURN
Your previous answer listed instruments but gave NO prices. That is not an acceptable answer to a discovery question. Call get_stock_price for each symbol you name — in parallel, in one turn — and reply with the names AND their current prices together. Do not ask which ones the user wants first.`
          : `

# THIS TURN
You already offered to look this up and the user already asked. Do NOT ask again. Call the tools you need, in parallel if it takes several, and answer with the real numbers now.`;
        const retry = await withDeadline(runAgent({
          apiKey: state.settings.llmApiKey || null,
          system: system + nudge,
          messages, profile: "fast",
        }), 12_000);
        const cleanRetry = stripScaffolding(retry);
        const retryStillBad = looksLikeLookupOffer(cleanRetry) || looksLikeFetchPromise(cleanRetry)
          || looksLikePricelessList(cleanRetry, userText);
        if (cleanRetry && cleanRetry.trim() && !retryStillBad) cleanedReply = cleanRetry;
      } catch (e) { console.warn("[chat] lookup-offer retry failed:", e?.message || e); }
    }
    cleanedReply = await finishReply(cleanedReply, userText, system, messages);
    const finalText = (cleanedReply && cleanedReply.trim()) ? cleanedReply : (errorText || "Saathi couldn't answer that. Try rephrasing or asking again.");
    if (live) {
      if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
      live.text = finalText; live.streaming = false; live.status = false; live.ts = Date.now();
    }
    else ownerMessages.push({ role: "assistant", text: finalText, ts: Date.now() });
    // Title/timestamp refresh on the owner session
    ownerSession.updatedAt = Date.now();
    if (!ownerSession.title || ownerSession.title === "New chat") {
      // Re-derive title from first user message
      const firstUser = ownerMessages.find(m => m.role === "user" && m.text);
      if (firstUser) ownerSession.title = String(firstUser.text).slice(0, 42).replace(/\s+/g, " ").trim();
    }
    saveSessions(sessionsData);
    if (replyText && replyText.trim()) {
      logChatTurn({
        userText, assistantText: finalText, model: "gemini-chat",
        sessionId: ownerSession.id, surface: "chat_page",
      });
    }
    if (isOwnerActive()) reRenderOuter();
    finalPaint();
    restoreForm();
    return;
  }

  // Streaming path: push an empty placeholder bubble INTO THE OWNER
  // SESSION, then append each token as it arrives. Even if the user
  // switches sessions mid-stream, tokens land in the right chat.
  const placeholderIdx = ownerMessages.length;
  ownerMessages.push({ role: "assistant", text: "", ts: Date.now(), streaming: true });
  reRenderOuter();

  // Typewriter drip — decouples Gemini's burst-y token arrivals (can
  // dump 40+ chars at once) from the on-screen reveal so the user sees
  // a buttery character-by-character fill instead of jerky chunks. The
  // raw tokens accumulate into `pendingFullText`; a 20ms timer advances
  // `displayedText` one small step at a time, scaling the step with
  // backlog so we never fall too far behind the stream. When the stream
  // ends, the timer keeps running until the buffer is drained.
  let pendingFullText = "";
  let displayedText = "";
  let streamDone = false;
  // Target ≈ 60-90 chars/sec on short backlog, accelerates as backlog
  // grows so the final drain after stream-end never feels stuck.
  const dripIntervalMs = 18;
  const typewriterDrip = () => {
    const entry = ownerMessages[placeholderIdx];
    if (!entry) return true;  // abandon
    if (displayedText.length >= pendingFullText.length) {
      if (streamDone) return true;  // all caught up, stream ended
      return false;
    }
    const remaining = pendingFullText.length - displayedText.length;
    // Base 2 chars/tick ≈ 110 chars/sec. Add backlog-scaled acceleration
    // so a 300-char chunk doesn't take 2.7 seconds to reveal.
    const step = Math.min(remaining, 2 + Math.floor(remaining / 40));
    displayedText = pendingFullText.slice(0, displayedText.length + step);
    entry.text = displayedText;
    // In-place bubble update — only touch the streaming message, not
    // the whole chat list. This is 10-50× cheaper than the full
    // reRenderOuter and is what makes the reveal feel buttery.
    const outerEl = document.getElementById("main");
    const streamBubble = outerEl?.querySelector('#chat-messages [data-streaming="1"] .msg-body');
    if (streamBubble) {
      streamBubble.innerHTML = renderMarkdown(displayedText);
      const msgs = outerEl?.querySelector("#chat-messages");
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    } else {
      // Placeholder bubble's data-streaming flag not painted yet — fall
      // back to full re-render on the first couple of ticks.
      reRenderOuter();
    }
    return false;
  };
  let dripTimer = setInterval(() => {
    if (typewriterDrip()) {
      clearInterval(dripTimer);
      dripTimer = null;
    }
  }, dripIntervalMs);

  // Named distinctly from the tool path's `system`. Two same-named consts in
  // nested scopes is what produced the TDZ bug above; keeping them distinct
  // means a stray reference is a loud ReferenceError, not a silent no-op.
  const streamSystem = `${SYSTEM_PROMPT}\n\n${NO_TOOLS_NOTE}\n\n${runtimeFacts(marketStatus())}\n\n${dossier}\n\n# TONE\nKeep replies conversational and short by default (1–3 sentences). Only go longer when the user asks for explanation or depth.

Answer only the latest message. Do not restate prices or facts from earlier turns unless the user asks for them again.` + turnLang;
  let result = null;
  try {
    result = await streamChat({
      system: streamSystem,
      messages,
      profile: "chat",
      signal: m_abortController.signal,
      onToken: (delta) => {
        if (!ownerMessages[placeholderIdx]) return;
        pendingFullText += delta;
        // Kick the timer if somehow it died.
        if (!dripTimer) {
          dripTimer = setInterval(() => {
            if (typewriterDrip()) { clearInterval(dripTimer); dripTimer = null; }
          }, dripIntervalMs);
        }
      },
    });
  } catch (e) {
    console.warn("coach stream error:", e);
  }
  streamDone = true;
  // Wait for the typewriter to drain the buffer before we restore the
  // form. Without this the user sees the Send button come back while
  // text is still typing, which reads as buggy.
  await new Promise((resolve) => {
    const waiter = setInterval(() => {
      if (displayedText.length >= pendingFullText.length) {
        clearInterval(waiter);
        if (dripTimer) { clearInterval(dripTimer); dripTimer = null; }
        resolve();
      }
    }, dripIntervalMs);
    // Safety: never wait more than 2 s (short streams should finish fast;
    // absurdly long responses will jump-to-end).
    setTimeout(() => {
      clearInterval(waiter);
      if (dripTimer) { clearInterval(dripTimer); dripTimer = null; }
      displayedText = pendingFullText;
      if (ownerMessages[placeholderIdx]) ownerMessages[placeholderIdx].text = displayedText;
      resolve();
    }, 2000);
  });
  m_pending = false;
  m_abortController = null;
  const entry = ownerMessages[placeholderIdx];
  // True while the bubble still holds the stream's own text (no retry ran),
  // which is what the figure check below applies to.
  let fromStream = true;
  // Everything below runs in a try/finally so the composer is re-enabled no
  // matter what happens in here. A thrown retry used to leave the input
  // disabled and the Stop button inert — the user could not send anything
  // again without reloading the page.
  try {
  if (entry) {
    entry.streaming = false;
    // Strip any leaked scaffolding from the streamed result. Done AFTER
    // the typewriter drained so the user-visible drip looks natural;
    // doing it mid-stream would cause text to disappear as it typed
    // (jarring). At this point the stream is finished so the in-place
    // mutation is invisible.
    if (entry.text) entry.text = stripScaffolding(entry.text);
    if (result?.aborted) {
      // User clicked Stop — keep whatever streamed so far and add a warm
      // sign-off rather than the clinical "[stopped]".
      const suffix = "\n\n— ok, I'll stop there. Ping me again if you want me to keep going.";
      entry.text = entry.text.trim()
        ? entry.text.trim() + suffix
        : "No worries — tap send again whenever you're ready.";
    } else if (result?.error && !entry.text.trim()) {
      entry.text = "Hmm, I'm having trouble reaching my brain right now. Give it a sec and try again?";
    } else if (!entry.text.trim() && result?.text) {
      entry.text = result.text;
    } else if (looksLikeLookupOffer(entry.text) || looksLikeFetchPromise(entry.text)) {
      // Streaming has no tools at all, so an offer here is guaranteed to be
      // a dead end. Re-run through runAgent and replace the bubble.
      //
      // BOUNDED. runAgent can take up to MAX_TOOL_LOOPS network round trips,
      // and this await sits between `m_pending = false` and restoreForm() —
      // so an unbounded one leaves the composer showing "Saathi is
      // responding…" with a Stop button that does nothing, because
      // m_abortController was already nulled above. That is exactly the
      // stuck state reported on 2026-09-13. Never let a retry outlive the
      // user's patience: cap it, and fall back to the original text.
      const sysT = `${SYSTEM_PROMPT}

${runtimeFacts(marketStatus())}

# THIS TURN
The user asked for data. Call the tools and answer with real numbers. Do NOT ask permission.`;
      const esc = await withDeadline(runAgent({
        apiKey: getState().settings.llmApiKey || null,
        system: sysT, messages, profile: "fast",
      }), 12_000);
      const cleanEsc = stripScaffolding(esc);
      if (cleanEsc && cleanEsc.trim()) { entry.text = cleanEsc.trim(); fromStream = false; }
    } else if (!entry.text.trim() && isToolCallOnly(result?.raw)) {
      // Reply was nothing but a tool call: the model decided it needed live
      // data while on the streaming path, which has no tools wired. It was
      // right about needing a tool. Re-run through runAgent rather than
      // telling the user we went quiet.
      const sys = `${SYSTEM_PROMPT}

${runtimeFacts(marketStatus())}

# TONE
Keep replies conversational and short by default (1–3 sentences).`;
      const retry = await withDeadline(runAgent({
        apiKey: getState().settings.llmApiKey || null,
        system: sys, messages, profile: "fast",
      }), 12_000);
      entry.text = (retry && stripScaffolding(retry).trim())
        ? stripScaffolding(retry).trim()
        : "Let me pull that up — ask me once more?";
      fromStream = false;
    } else if (!entry.text.trim()) {
      entry.text = "Hmm, I went quiet there. Ask me once more?";
    }
    // C6: the no-tools path has no prices, so any price, "% today" or $/₹
    // event figure in it was made up (ADANIGREEN "₹1,845.20", real ~₹1,313).
    // Re-run the turn on the tool path; failing that, drop those sentences.
    if (fromStream && !result?.aborted && entry.text && !entry.text.startsWith("Hmm")) {
      const figs = unsourcedFigures(entry.text, figureSources(streamSystem, messages));
      if (figs.length) {
        const toolSys = `${SYSTEM_PROMPT}

${runtimeFacts(marketStatus())}

${dossier}` + (await prefetchNewsBlock(userText)) + `

# THIS TURN
Your earlier draft stated prices, moves or events that were not looked up. Call the tool for every figure you give (get_stock_price for a price or today's move, get_market_news for news), or leave the figure out.` + turnLang;
        const redo = await withDeadline(runAgent({
          apiKey: getState().settings.llmApiKey || null,
          system: toolSys, messages, profile: "fast",
        }), 12_000).catch(() => null);
        const cleanRedo = stripScaffolding(redo);
        if (cleanRedo && cleanRedo.trim()) entry.text = cleanRedo.trim();
        else entry.text = dropFigureSentences(entry.text, figs) || entry.text;
      }
    }
    if (!result?.aborted && entry.text && !entry.text.startsWith("Hmm")) {
      entry.text = await finishReply(entry.text, userText, streamSystem, messages);
    }
    // Save the OWNER session (refresh its timestamp + title)
    ownerSession.updatedAt = Date.now();
    if (!ownerSession.title || ownerSession.title === "New chat") {
      const firstUser = ownerMessages.find(m => m.role === "user" && m.text);
      if (firstUser) ownerSession.title = String(firstUser.text).slice(0, 42).replace(/\s+/g, " ").trim();
    }
    saveSessions(sessionsData);
    if (isOwnerActive()) reRenderOuter();
    // Log the finished turn (not aborted, not error) so admin can review
    // AND so rebuildChatSessionsFromDb on the next boot reconstructs
    // the same session the user is looking at now.
    if (!result?.aborted && !result?.error && entry.text && !entry.text.startsWith("Hmm")) {
      logChatTurn({
        userText, assistantText: entry.text, model: "gemini-chat",
        sessionId: ownerSession.id, surface: "chat_page",
      });
    }
  }
  } finally {
    finalPaint();
    restoreForm();
  }
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
