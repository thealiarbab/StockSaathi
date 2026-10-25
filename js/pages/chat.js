// =============================================================================
// CHAT — A simple coaching chatbot for teens learning to invest.
// Uses the BYO LLM path (if API key set) or deterministic template responses
// as fallback.
// =============================================================================

import { getState, setSetting } from "../state.js";
import { getInstrument, STOCKS } from "../data/universe.js";
import { SYSTEM_PROMPT, matchTemplate, isOffTopic, offTopicRedirect, STARTER_QUESTIONS, runtimeFacts, NO_TOOLS_NOTE } from "../coach/persona.js";
import { marketStatus } from "../data/prices.js";
import { runAgent, streamChat, needsLiveData, logChatTurn, stripToolCallScaffolding, isToolCallOnly, looksLikeLookupOffer, looksLikeFetchPromise, looksLikePricelessList, isDiscoveryQuery, scrubAdvice, looksHinglish, hasFormalHindiRegister, prefetchNewsBlock, unsourcedFigures, figureSources, dropFigureSentences } from "../coach/agent.js";
import { buildDossier } from "../coach/dossier.js";
import { normalizeLookupProvenance, withLookupProvenance } from "../coach/lookupProvenance.js";
import { getNews } from "../data/news.js";
import {
  loadSessions, saveSessions, getActiveSession, setActiveSession,
  createNewSession, deleteSessionById, touchActive, clearActiveMessages,
  renameSession, togglePin,
  formatRelative, SESSIONS_KEY,
  displayOrder, setArchived, notePruned, setFolder,
} from "../features/chatSessions.js";
import { nextTs, repairTurnOrder } from "../features/chatOrder.js";
import { isPreview } from "../features/preview.js";
import { listProjects, getProject, createProject, renameProject, setInstructions, removeProject, syncProjects, projectNote } from "../features/chatProjects.js";
import { forkAt, showVersion, branchInfo, stripVers } from "../features/chatBranches.js";
import { pushThread, pullThreads, upsertShare, listShares, revokeShare, sendFeedback } from "../features/chatCloud.js";
import { COMMANDS, isCommand, runCommand, cardHtml, hydrateCards, guideHtml, guideCompactHtml, CHART_TOOL_NOTE, hideChartMarkers, extractChartMarker } from "../features/chatCards.js";
import { toast } from "../components/toast.js";
import { onBackdropClick } from "../components/backdrop.js";
import { logEvent } from "../features/telemetry.js";

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
async function finishReply(text, userText, system, messages, onStep) {
  let out = text;
  const hi = !!getState().settings.hinglish;
  if (hi && (!looksHinglish(out) || hasFormalHindiRegister(out))) {
    try {
      const again = await withDeadline(runAgent({
        apiKey: getState().settings.llmApiKey || null,
        system: `${system}

# THIS TURN
Your last draft did not follow the requested Hinglish style. Rewrite it in casual Hinglish: mix everyday Roman Hindi with natural English words, keep finance terms in English, and avoid formal Hindi such as 'tulna', 'ummeed', 'nirnay', 'nivesh', 'laabh', 'saalana', 'keemat' and 'moolya'.`,
        messages, profile: "fast",
        onStep,
      }), 12_000);
      const clean = stripScaffolding(again);
      if (clean && clean.trim() && looksHinglish(clean) && !hasFormalHindiRegister(clean)) out = clean.trim();
    } catch (e) { console.warn("[chat] language retry failed:", e?.message || e); }
  }
  return scrubAdvice(out, userText, hi).text;
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
    const repaint = () => {
      if (!document.getElementById("chat-messages")) return;
      const main = chatHost();
      if (main) renderChat(main);
    };
    if (isPreview()) {
      // DB hydration rebuilds chats as flat logs. Wait for the richer cloud
      // threads (branches, cards, and ordering) before painting, or tab focus
      // briefly shows that incomplete version.
      syncFromCloud().then(repaint).catch((e) => {
        console.warn("[chat] cloud sync after coach hydration failed:", e);
        repaint();
      });
    } else {
      repaint();
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

// The element the chat is drawn into: <main> on /chat, or the coach pop-up's
// box, which shows this same view (coachPanel.js).
let _host = null;
function chatHost() {
  return (_host && _host.isConnected) ? _host : document.getElementById("main");
}

export function renderChat(main, opts = {}) {
  _host = main;
  const embedded = !!opts.embedded;
  // App-style page: no site footer, only the messages scroll. Not when
  // drawn inside the coach pop-up: the page underneath stays as it is.
  if (!embedded) {
    main.classList.add("main-chat");
    document.body.classList.add("chat-app");
  }
  let updateDraft = null;
  try {
    const rawDraft = sessionStorage.getItem("ss.sw-update-chat-draft.v1");
    if (rawDraft) {
      sessionStorage.removeItem("ss.sw-update-chat-draft.v1");
      const draft = JSON.parse(rawDraft);
      if (draft.path === location.pathname && typeof draft.value === "string") updateDraft = draft;
    }
  } catch (e) {
    console.warn("[chat] couldn't read draft after app update:", e);
  }
  const leaveChat = () => {
    // The router fires ss:navigate for this page too; only undo on a real exit.
    if (location.pathname.replace(/\/+$/, "") === "/chat") return;
    main.classList.remove("main-chat");
    document.body.classList.remove("chat-app");
    window.removeEventListener("ss:navigate", leaveChat);
    window.removeEventListener("popstate", leaveChat);
  };
  if (!embedded) {
    window.addEventListener("ss:navigate", () => setTimeout(leaveChat, 0));
    window.addEventListener("popstate", () => setTimeout(leaveChat, 0));
  }
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
    const oldInput = main.querySelector("#chat-input");
    const carriedDraft = updateDraft || (oldInput ? {
      value: oldInput.value,
      start: oldInput.selectionStart,
      end: oldInput.selectionEnd,
    } : null);
    updateDraft = null;
    const state = getState();
    const active = getActiveSession(sessionsData);
    // A repaint of the chat on screen (cloud sync, another tab, the language
    // switch) keeps the reader's place; opening a chat starts at the end.
    const prevEl = main.querySelector("#chat-messages");
    const keep = prevEl && prevEl._follow === false && main.dataset.chatId === active.id
      ? prevEl.scrollTop : null;
    main.dataset.chatId = active.id;

    main.innerHTML = `
      <div class="cc cc-has-side ${drawerOpen ? "is-drawer-open" : ""} ${sidebarHidden ? "is-side-hidden" : ""}">
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
          ${isPreview() ? `<button type="button" class="cc-side-guide" data-open-guide>
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 8-4 4 4 4"/><path d="m17 8 4 4-4 4"/><path d="m14 4-4 16"/></svg>
            Commands guide</button>` : ""}
          <nav class="cc-list" id="cc-list">${renderChatList()}</nav>
        </aside>
        <button class="cc-scrim" id="cc-scrim" type="button" aria-label="Close chat list" tabindex="-1"></button>

        <section class="cc-main">
          <header class="cc-head">
            <button class="cc-chip-btn cc-menu-btn" id="cc-open-side" type="button" aria-controls="cc-side" aria-expanded="${window.innerWidth <= 900 ? drawerOpen : !sidebarHidden}" aria-label="${window.innerWidth <= 900 ? (drawerOpen ? "Close chat list" : "Open chat list") : (sidebarHidden ? "Show chat list" : "Hide chat list")}">
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
              Chats
            </button>
            <div class="cc-id">
              <h1 class="cc-title">${chatLog.length ? escapeHtml(active.title || "Saathi") : "Saathi"}</h1>
            </div>
            <button class="cc-chip-btn coach-lang ${state.settings.hinglish ? "is-on" : ""}" id="cc-lang" type="button" aria-label="Switch reply language to ${state.settings.hinglish ? "English" : "Hinglish (Hindi in Roman script)"}" aria-pressed="${state.settings.hinglish ? "true" : "false"}">${state.settings.hinglish ? "Switch to English" : "Switch to Hinglish"}</button>
            ${isPreview() ? `
            <button class="cc-chip-btn cc-head-share" id="cc-share" type="button" aria-label="Share this chat">
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/></svg><span>Share</span>
            </button>
            <button class="cc-chip-btn cc-head-more" id="cc-more" type="button" aria-label="More chat options" aria-haspopup="menu">&middot;&middot;&middot;</button>` : ""}
            <button class="cc-chip-btn cc-new cc-head-new" id="chat-new-btn-2" type="button" aria-label="New chat">+</button>
          </header>

          <div class="cc-panel chat-card ${chatLog.length ? "" : "is-empty"}">
            <div id="chat-messages" class="chat-messages cc-messages">
              ${renderMessages()}
            </div>

            <div class="cc-slash" id="cc-slash" role="listbox" aria-label="Commands" hidden></div>
            <form id="chat-form" class="composer cc-composer">
              <div class="composer-shell ${m_pending ? "is-busy" : ""}">
                <textarea
                  id="chat-input"
                  class="composer-input"
                  rows="1"
                  placeholder="${m_pending ? "Type your next message…" : composerHint()}"
                  autocomplete="off"
                  maxlength="2000"
                  aria-label="Message Saathi"
                ></textarea>
                <button class="cc-tool-btn" id="cc-chart-btn" type="button" title="Ask Saathi to read a stock chart" aria-label="Read a stock chart">
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/></svg>
                  <span>Chart</span>
                </button>
                ${m_pending
                  ? `<button class="composer-btn is-stop" id="chat-stop" type="button" title="Stop generating" aria-label="Stop generating">&#9632;</button>`
                  : `<button class="composer-btn" id="chat-send" type="submit" title="Send" aria-label="Send message">&#8593;</button>`}
              </div>
            </form>
            <button class="cc-jump" id="cc-jump" type="button" aria-label="Jump to latest message" hidden>
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
            </button>
          </div>
          <p class="cc-foot">Saathi can make mistakes. Practice only, not investment advice.</p>
        </section>
      </div>
    `;

    const input = main.querySelector("#chat-input");
    const form = main.querySelector("#chat-form");
    main.querySelector("#cc-lang")?.addEventListener("click", (e) => {
      const on = !getState().settings.hinglish;
      setSetting("hinglish", on);
      e.currentTarget.textContent = on ? "Switch to English" : "Switch to Hinglish";
      e.currentTarget.setAttribute("aria-label", `Switch reply language to ${on ? "English" : "Hinglish (Hindi in Roman script)"}`);
      e.currentTarget.classList.toggle("is-on", on);
      e.currentTarget.setAttribute("aria-pressed", on ? "true" : "false");
      // The empty-chat guide is written in the chosen language.
      if (!chatLog.length && isPreview()) { rerender(); fillStarters(main, (q) => { if (m_pending) return; input.value = q; form.requestSubmit(); }); }
    });
    if (!chatLog.length) fillStarters(main, (q) => { if (m_pending) return; input.value = q; form.requestSubmit(); });
    const messagesEl = main.querySelector("#chat-messages");
    if (keep != null) { messagesEl._follow = false; messagesEl.scrollTop = keep; }
    else if (chatLog.length) stickBottom(messagesEl, true);
    // Desktop: auto-focus so the user can start typing. Mobile: don't —
    // focusing an input pops the soft keyboard, and the user hasn't
    // asked for it yet. They can tap the input themselves to start.
    if (window.innerWidth >= 1024 && !drawerOpen) input.focus();

    // Grows with the text up to ~8 lines, like the big chat apps.
    const fit = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; input.style.overflowY = input.scrollHeight > 200 ? "auto" : "hidden"; };
    input.addEventListener("input", fit);
    if (carriedDraft && typeof carriedDraft.value === "string") {
      input.value = carriedDraft.value;
      fit();
      input.setSelectionRange(
        Number.isInteger(carriedDraft.start) ? carriedDraft.start : input.value.length,
        Number.isInteger(carriedDraft.end) ? carriedDraft.end : input.value.length,
      );
    }
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
      // The chart button fills in "Read the 3-month chart of " for the student
      // to finish. Sent as is (25 Oct), Saathi had no stock to read.
      if (/\bchart of$/i.test(text)) {
        toast({ kind: "info", message: "Add a stock name after \"chart of\", like TCS or Reliance." });
        input.focus();
        return;
      }
      input.value = "";
      fit();
      main.querySelector(".cc-panel")?.classList.remove("is-empty");
      closeSlash();
      const userMessage = pushUser(text);
      const submittedSessionId = getActiveSession(sessionsData).id;
      logChatTurn({
        userText: text, assistantText: "", sessionId: submittedSessionId,
        surface: "chat_page", userTs: userMessage.ts,
      });
      cloudSave(true);
      messagesEl._follow = true;    // sending always goes back to the end
      rerender();
      refreshSide();
      const replyPromise = produceReply(text);
      try {
        await replyPromise;
      } catch (e) {
        console.error("[chat] reply failed:", e);
        const session = sessionsData.sessions.find((s) => s.id === submittedSessionId);
        const userIndex = session?.messages.findIndex((m) => m.role === "user" && m.ts === userMessage.ts) ?? -1;
        if (session && userIndex >= 0) {
          const next = session.messages.slice(userIndex + 1).find((m) => m.role === "user" || m.role === "assistant");
          if (!next || next.role === "user" || (next.streaming && !next.text)) {
            const replyText = "I hit a snag before I could finish that reply. Please try again.";
            if (next?.role === "assistant") {
              next.text = replyText;
              next.streaming = false;
            } else {
              session.messages.splice(userIndex + 1, 0, { role: "assistant", text: replyText, ts: userMessage.ts + 1 });
            }
            saveSessions(sessionsData);
            logChatTurn({
              userText: "", assistantText: replyText, model: "client-error",
              sessionId: submittedSessionId, surface: "chat_page", replyTs: userMessage.ts + 1,
            });
          }
        }
      } finally {
        m_pending = false;
        m_abortController = null;
      }
      rerender();
      refreshSide();
      cloudSave(true);
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
      const gap = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
      // Scrolled up to read: stop following new text until back at the end.
      messagesEl._follow = gap < 80;
      jump.hidden = gap < 160;
    }, { passive: true });
    jump.addEventListener("click", () => {
      messagesEl._follow = true;
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
    });

    // ---- Preview controls (owner accounts first; see features/preview.js) ----
    if (isPreview()) {
      afterPaint(messagesEl);
      if (!syncFromCloud._started) {
        syncFromCloud._started = true;
        Promise.all([syncFromCloud(), syncProjects()]).then(([a, b]) => { if ((a || b) && document.getElementById("chat-messages")) render(); });
      }

      messagesEl.addEventListener("click", async (e) => {
        const t = e.target.closest("[data-edit],[data-regen],[data-ver],[data-fb],[data-fb-why]");
        if (!t) return;
        const sess = getActiveSession(sessionsData);
        if (t.dataset.fbWhy) {
          const m = chatLog[+t.dataset.idx];
          sendFeedback({ threadId: sess.id, ts: m?.ts, rating: -1, reason: t.dataset.fbWhy, reply: m?.text });
          t.closest(".cc-fb-why")?.replaceWith(Object.assign(document.createElement("div"), { className: "cc-fb-thanks", textContent: "Thanks. That helps Saathi get better." }));
          return;
        }
        if (t.dataset.fb != null) {
          const i = +t.dataset.idx, val = +t.dataset.fb, m = chatLog[i];
          if (!m) return;
          m.fb = m.fb === val ? 0 : val;
          if (m.fb) sendFeedback({ threadId: sess.id, ts: m.ts, rating: val, reply: m.text });
          saveChat(); cloudSave();
          const row = t.closest(".cc-actions-row");
          row.querySelectorAll("[data-fb]").forEach((b) => { const on = +b.dataset.fb === m.fb; b.classList.toggle("is-on", on); b.setAttribute("aria-pressed", on); });
          row.parentElement.querySelector(".cc-fb-why")?.remove();
          if (m.fb === -1) {
            row.insertAdjacentHTML("afterend", `<div class="cc-fb-why" role="group" aria-label="What was wrong?">${["Wrong numbers", "Didn't answer my question", "Too long", "Sounded like a tip", "Something else"]
              .map((r) => `<button type="button" data-fb-why="${escapeAttr(r)}" data-idx="${i}">${escapeHtml(r)}</button>`).join("")}</div>`);
          }
          return;
        }
        if (m_pending) return;
        if (t.dataset.ver != null) {
          const i = +t.dataset.ver, b = branchInfo(chatLog, i);
          if (!b) return;
          const removed = showVersion(chatLog, i, b.cur - 1 + +t.dataset.dir);
          notePruned(sess, removed, chatLog);
          saveChat(); rerender(); cloudSave();
          return;
        }
        if (t.dataset.regen != null) { await regenerate(+t.dataset.regen); return; }
        if (t.dataset.edit != null) startEdit(+t.dataset.edit);
      });

      main.querySelector("#cc-share")?.addEventListener("click", () => {
        const sess = getActiveSession(sessionsData);
        if (!(sess.messages || []).length) { toast({ kind: "info", message: "Send a message first, then share the chat." }); return; }
        openShare(sess);
      });
      main.querySelector("#cc-more")?.addEventListener("click", (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        const had = document.querySelector(".cc-head-menu");
        had?.remove();
        if (had) return;
        const sess = getActiveSession(sessionsData);
        btn.insertAdjacentHTML("afterend", `<div class="cc-item-menu cc-head-menu" role="menu">
          <button type="button" role="menuitem" data-head="md">Export as Markdown</button>
          <button type="button" role="menuitem" data-head="pdf">Print or save as PDF</button>
          <button type="button" role="menuitem" data-head="links">Shared links</button>
          <button type="button" role="menuitem" data-head="archive">${sess.archived ? "Unarchive" : "Archive"} chat</button>
        </div>`);
        const menu = btn.parentElement.querySelector(".cc-head-menu");
        menu.querySelector("button")?.focus();
        menu.addEventListener("click", (ev) => {
          const a = ev.target.closest("[data-head]")?.dataset.head;
          menu.remove();
          if (a === "md") downloadText(`${(sess.title || "chat").replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.md`, chatMarkdown(sess));
          else if (a === "pdf") printChat(sess);
          else if (a === "links") openSharedLinks();
          else if (a === "archive") {
            setArchived(sessionsData, sess.id, !sess.archived);
            pushThread(sess, { now: true });
            toast({ kind: "success", message: sess.archived ? "Chat archived. Find it under Archived in the chat list." : "Chat unarchived." });
            if (sess.archived) newChat(); else render();
          }
        });
        setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
      });

      // Slash commands: a menu while the box starts with "/".
      const slash = main.querySelector("#cc-slash");
      let slashSel = 0;
      const slashItems = () => {
        const v = input.value;
        if (!v.startsWith("/") || /\s/.test(v)) return [];
        return COMMANDS.filter((c) => c.cmd.startsWith(v.toLowerCase()));
      };
      const drawSlash = () => {
        const items = slashItems();
        if (!items.length) { closeSlash(); return; }
        slashSel = Math.min(slashSel, items.length - 1);
        slash.hidden = false;
        slash.innerHTML = items.map((c, k) => `<button type="button" role="option" aria-selected="${k === slashSel}" data-slash="${escapeAttr(c.cmd)}"><b>${escapeHtml(c.cmd)}</b> <span>${escapeHtml(c.args)}</span><em>${escapeHtml(getState().settings.hinglish ? c.hintHi : c.hint)}</em></button>`).join("");
      };
      const pickSlash = (cmd) => { input.value = cmd + " "; closeSlash(); fit(); input.focus(); };
      input.addEventListener("input", drawSlash);
      input.addEventListener("keydown", (e) => {
        if (slash.hidden) return;
        const items = slashItems();
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); slashSel = (slashSel + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length; drawSlash(); }
        else if (e.key === "Tab" || (e.key === "Enter" && items[slashSel] && input.value.trim() !== items[slashSel].cmd)) { e.preventDefault(); e.stopImmediatePropagation(); if (items[slashSel]) pickSlash(items[slashSel].cmd); }
        else if (e.key === "Escape") closeSlash();
      }, true);
      slash.addEventListener("mousedown", (e) => { const b = e.target.closest("[data-slash]"); if (b) { e.preventDefault(); pickSlash(b.dataset.slash); } });

      // Shortcuts: Ctrl/Cmd+Shift+O new chat, Shift+Esc focus the box.
      const onShort = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); newChat(); }
        else if (e.shiftKey && e.key === "Escape") { e.preventDefault(); input.focus(); }
      };
      document.addEventListener("keydown", onShort);
      window.addEventListener("ss:navigate", () => document.removeEventListener("keydown", onShort), { once: true });
    }

    function closeSlash() {
      const el = main.querySelector("#cc-slash");
      if (el) { el.hidden = true; el.innerHTML = ""; }
    }

    // Edit a question: an editor in place of the bubble; Send forks the chat.
    function startEdit(i) {
      const m = chatLog[i];
      const row = messagesEl.querySelector(`.cc-row[data-i="${i}"]`);
      if (!m || !row) return;
      const col = row.querySelector(".cc-user-col");
      col.innerHTML = `<div class="cc-edit"><textarea class="cc-edit-box" rows="2" aria-label="Edit your message">${escapeHtml(m.text)}</textarea>
        <div class="cc-edit-actions"><button type="button" class="cc-btn cc-btn-ghost" data-edit-cancel>Cancel</button><button type="button" class="cc-btn cc-btn-primary" data-edit-send>Send</button></div></div>`;
      const box = col.querySelector("textarea");
      const grow = () => { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight, 240) + "px"; };
      grow(); box.focus(); box.setSelectionRange(box.value.length, box.value.length);
      box.addEventListener("input", grow);
      const send = async () => {
        const text = box.value.trim();
        if (!text || text === m.text) { rerender(); return; }
        logEvent("coach", "edit", { surface: "chat_page" });
        const sess = getActiveSession(sessionsData);
        const removed = forkAt(chatLog, i, { role: "user", text, ts: Date.now() });
        notePruned(sess, removed, chatLog);
        saveChat(); rerender(); refreshSide();
        await produceReply(text);
        notePruned(sess, [], chatLog);
        saveChat(); rerender(); refreshSide(); cloudSave(true);
      };
      col.querySelector("[data-edit-cancel]").addEventListener("click", () => rerender());
      col.querySelector("[data-edit-send]").addEventListener("click", send);
      box.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
        if (e.key === "Escape") rerender();
      });
    }

    // Regenerate: the old answer becomes version n-1 of a branch point.
    async function regenerate(i) {
      const head = chatLog[i];
      const q = chatLog[i - 1];
      if (!head || head.role !== "assistant" || !q || q.role !== "user") return;
      logEvent("coach", "regenerate", { surface: "chat_page" });
      const sess = getActiveSession(sessionsData);
      const vers = Array.isArray(head.vers) && head.vers.length ? head.vers.slice() : [];
      const vi = Number.isInteger(head.vi) && vers.length ? head.vi : 0;
      vers[vi] = [stripVers(head), ...chatLog.slice(i + 1)];
      const removed = chatLog.splice(i);
      notePruned(sess, removed, []);
      saveChat(); rerender();
      await produceReply(q.text);
      const nh = chatLog[i];
      if (nh && nh.role === "assistant") {
        vers.push([stripVers(nh), ...chatLog.slice(i + 1)]);
        nh.vers = vers;
        nh.vi = vers.length - 1;
      }
      notePruned(sess, [], chatLog);
      saveChat(); rerender(); cloudSave(true);
    }

    main.querySelector("#cc-chart-btn")?.addEventListener("click", () => {
      if (!/chart/i.test(input.value)) input.value = "Read the 3-month chart of " + input.value.trimStart();
      fit();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });

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
    const newChat = (folder = null) => {
      stopStream();
      // Reuse an empty chat instead of piling up blank ones.
      const blank = sessionsData.sessions.find(x => !(x.messages || []).length);
      if (blank) setActiveSession(sessionsData, blank.id);
      else createNewSession(sessionsData);
      const fresh = getActiveSession(sessionsData);
      if ((fresh.folder || null) !== (typeof folder === "string" ? folder : null)) setFolder(sessionsData, fresh.id, typeof folder === "string" ? folder : null);
      if (fresh.folder) openProjects.add(fresh.folder);
      rebindActiveChatLog();
      sideQuery = "";
      drawerOpen = false;
      render();
    };
    main.querySelector("#chat-new-btn")?.addEventListener("click", () => newChat());
    main.querySelector("#chat-new-btn-2")?.addEventListener("click", () => newChat());

    // Drawer (phones and narrow windows).
    const setDrawer = (open) => {
      drawerOpen = open;
      main.querySelector(".cc")?.classList.toggle("is-drawer-open", open);
      const toggle = main.querySelector("#cc-open-side");
      toggle?.setAttribute("aria-expanded", open ? "true" : "false");
      toggle?.setAttribute("aria-label", open ? "Close chat list" : "Open chat list");
      if (open) main.querySelector("#cc-search")?.focus();
    };
    main.querySelector("#cc-open-side")?.addEventListener("click", (e) => {
      if (window.innerWidth <= 900) {
        setDrawer(!drawerOpen);
        return;
      }
      sidebarHidden = !sidebarHidden;
      main.querySelector(".cc")?.classList.toggle("is-side-hidden", sidebarHidden);
      e.currentTarget.setAttribute("aria-expanded", sidebarHidden ? "false" : "true");
      e.currentTarget.setAttribute("aria-label", sidebarHidden ? "Show chat list" : "Hide chat list");
    });
    main.querySelector("#cc-side-close")?.addEventListener("click", () => setDrawer(false));
    main.querySelector("#cc-scrim")?.addEventListener("click", () => setDrawer(false));

    const search = main.querySelector("#cc-search");
    search?.addEventListener("input", () => { sideQuery = search.value; refreshSide(); });

    const list = main.querySelector("#cc-list");
    const closeMenus = () => list?.querySelectorAll(".cc-item-menu").forEach(m => m.remove());
    list?.addEventListener("click", (e) => {
      // ---- Projects (preview) ----
      const pj = e.target.closest("[data-proj-new],[data-proj-chat],[data-proj-more],[data-proj-act],[data-move],[data-proj-toggle]");
      if (pj) {
        e.preventDefault(); e.stopPropagation();
        if (pj.dataset.projToggle) {
          const id = pj.dataset.projToggle;
          const isOpen = pj.getAttribute("aria-expanded") === "true";
          if (isOpen) openProjects.delete(id); else openProjects.add(id);
          // The open chat's project stays open; collapsing it means "not now".
          if (isOpen) collapsed.add(id); else collapsed.delete(id);
          refreshSide();
          return;
        }
        if (pj.dataset.projNew != null) { askProjectName("New project", "", (name) => { const p = createProject(name); if (p) { openProjects.add(p.id); refreshSide(); } }); return; }
        if (pj.dataset.projChat) { newChat(pj.dataset.projChat); return; }
        if (pj.dataset.projMore) {
          const head = pj.closest(".cc-proj-head");
          const had = head.parentElement.querySelector(":scope > .cc-item-menu");
          closeMenus();
          if (had) return;
          const id = pj.dataset.projMore;
          head.insertAdjacentHTML("afterend", `<div class="cc-item-menu cc-proj-menu" role="menu">
            <button type="button" role="menuitem" data-proj-act="instr" data-id="${escapeAttr(id)}">Instructions</button>
            <button type="button" role="menuitem" data-proj-act="rename" data-id="${escapeAttr(id)}">Rename</button>
            <button type="button" role="menuitem" data-proj-act="remove" data-id="${escapeAttr(id)}" class="is-danger">Delete project</button>
          </div>`);
          return;
        }
        if (pj.dataset.projAct) {
          const id = pj.dataset.id, p = getProject(id);
          closeMenus();
          if (!p) return;
          if (pj.dataset.projAct === "rename") askProjectName("Rename project", p.name, (name) => { renameProject(id, name); refreshSide(); });
          else if (pj.dataset.projAct === "instr") openInstructions(p);
          else if (pj.dataset.projAct === "remove") {
            if (!confirm(`Delete the project "${p.name}"? Its chats stay, back in your chat list.`)) return;
            for (const x of sessionsData.sessions) if (x.folder === id) { setFolder(sessionsData, x.id, null); pushThread(x); }
            removeProject(id);
            refreshSide();
          }
          return;
        }
        if (pj.dataset.move != null) {
          const sid = pj.dataset.id, sess = sessionsData.sessions.find(x => x.id === sid);
          closeMenus();
          if (!sess) return;
          const apply = (folder) => { setFolder(sessionsData, sid, folder); pushThread(sess); if (folder) openProjects.add(folder); refreshSide(); };
          if (pj.dataset.move === "__new") askProjectName("New project", "", (name) => { const p = createProject(name); if (p) apply(p.id); });
          else apply(pj.dataset.move || null);
          return;
        }
      }
      const openBtn = e.target.closest("[data-open]");
      const moreBtn = e.target.closest("[data-more]");
      const act = e.target.closest("[data-act]");
      if (act) {
        e.stopPropagation();
        const id = act.dataset.id;
        const sess = sessionsData.sessions.find(x => x.id === id);
        closeMenus();
        if (!sess) return;
        if (act.dataset.act === "pin") { togglePin(sessionsData, id); refreshSide(); if (isPreview()) pushThread(sess); }
        else if (act.dataset.act === "share") openShare(sess);
        else if (act.dataset.act === "archive") {
          setArchived(sessionsData, id, !sess.archived);
          pushThread(sess, { now: true });
          if (sess.archived && sessionsData.activeId === id) newChat(); else refreshSide();
        }
        else if (act.dataset.act === "rename") startRename(id);
        else if (act.dataset.act === "move") {
          const row = list.querySelector(`.cc-item[data-id="${CSS.escape(id)}"]`);
          const ps = listProjects();
          row?.insertAdjacentHTML("beforeend", `<div class="cc-item-menu" role="menu" aria-label="Move to project">
            ${ps.map(p => `<button type="button" role="menuitem" data-move="${escapeAttr(p.id)}" data-id="${escapeAttr(id)}" ${sess.folder === p.id ? 'aria-checked="true"' : ""}>${escapeHtml(p.name)}${sess.folder === p.id ? " ✓" : ""}</button>`).join("")}
            <button type="button" role="menuitem" data-move="__new" data-id="${escapeAttr(id)}">+ New project</button>
            ${sess.folder ? `<button type="button" role="menuitem" data-move="" data-id="${escapeAttr(id)}">Remove from project</button>` : ""}
          </div>`);
          row?.querySelector(".cc-item-menu button")?.focus();
        }
        else if (act.dataset.act === "delete") {
          if (!confirm(`Delete "${sess.title || "this chat"}"? This can't be undone.`)) return;
          if (sessionsData.activeId === id) stopStream();
          if (isPreview()) pushThread({ ...sess, trashed: true }, { now: true });
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
            ${isPreview() ? `<button type="button" role="menuitem" data-act="share" data-id="${escapeAttr(id)}">Share</button>
            <button type="button" role="menuitem" data-act="move" data-id="${escapeAttr(id)}">Move to project</button>
            <button type="button" role="menuitem" data-act="archive" data-id="${escapeAttr(id)}">${sess?.archived ? "Unarchive" : "Archive"}</button>` : ""}
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

    function askProjectName(title, value, done) {
      openModal(`
        <div class="cc-modal-head"><h2>${escapeHtml(title)}</h2><button type="button" class="cc-x" data-close aria-label="Close">&times;</button></div>
        <p class="cc-modal-sub">Keep related chats together, like a school project or a stock you're tracking.</p>
        <input class="cc-modal-input" id="cc-proj-name" maxlength="60" placeholder="e.g. Banking stocks" value="${escapeAttr(value)}" aria-label="Project name">
        <div class="cc-modal-actions"><button type="button" class="cc-btn cc-btn-ghost" data-close>Cancel</button><button type="button" class="cc-btn cc-btn-primary" id="cc-proj-ok">Save</button></div>`, (box, close) => {
        const inp = box.querySelector("#cc-proj-name");
        const ok = () => { const v = inp.value.trim(); if (!v) { inp.focus(); return; } close(); done(v); };
        box.querySelector("#cc-proj-ok").addEventListener("click", ok);
        inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); ok(); } });
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
      });
    }
    function openInstructions(p) {
      openModal(`
        <div class="cc-modal-head"><h2>Instructions for ${escapeHtml(p.name)}</h2><button type="button" class="cc-x" data-close aria-label="Close">&times;</button></div>
        <p class="cc-modal-sub">Saathi follows these in every chat in this project. For example: "I'm 15 and new to this, keep it simple" or "Compare everything with HDFC Bank".</p>
        <textarea class="cc-modal-input cc-modal-area" id="cc-proj-ins" maxlength="1500" rows="5" aria-label="Project instructions">${escapeHtml(p.instructions || "")}</textarea>
        <div class="cc-modal-actions"><button type="button" class="cc-btn cc-btn-ghost" data-close>Cancel</button><button type="button" class="cc-btn cc-btn-primary" id="cc-proj-save">Save</button></div>`, (box, close) => {
        box.querySelector("#cc-proj-save").addEventListener("click", () => {
          setInstructions(p.id, box.querySelector("#cc-proj-ins").value);
          close();
          toast({ kind: "success", message: `Saved. Saathi will follow these in "${p.name}".` });
        });
      });
    }

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
        if (save && isPreview()) pushThread(sessionsData.sessions.find(x => x.id === id));
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
    const archived = sessionsData.sessions.filter(x => x.archived && (x.messages || []).length);
    const projects = isPreview() ? listProjects() : [];
    const live = new Set(projects.map(p => p.id));
    const inProject = (x) => x.folder && live.has(x.folder);
    const all = sessionsData.sessions
      .filter(x => !x.archived)
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
    const projHtml = !isPreview() ? "" : `
      <div class="cc-group cc-projects">
        <div class="cc-group-row"><h2 class="cc-group-name">Projects</h2><button type="button" class="cc-proj-add" data-proj-new aria-label="New project">+ New</button></div>
        ${projects.length ? projects.map(p => {
          const chats = all.filter(x => x.folder === p.id);
          const open = openProjects.has(p.id) || (!collapsed.has(p.id) && getActiveSession(sessionsData)?.folder === p.id);
          return `<div class="cc-project ${open ? "is-open" : ""}" data-proj="${escapeAttr(p.id)}">
            <div class="cc-proj-head">
              <button type="button" class="cc-proj-toggle" data-proj-toggle="${escapeAttr(p.id)}" aria-expanded="${open}">
                <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
                <span class="cc-proj-name">${escapeHtml(p.name)}</span><span class="cc-proj-n">${chats.length}</span>
              </button>
              <button type="button" class="cc-item-more" data-proj-more="${escapeAttr(p.id)}" aria-label="Options for ${escapeAttr(p.name)}" aria-haspopup="menu">&middot;&middot;&middot;</button>
            </div>
            ${open ? `<div class="cc-proj-body">
              <button type="button" class="cc-proj-newchat" data-proj-chat="${escapeAttr(p.id)}">+ New chat in ${escapeHtml(p.name)}</button>
              ${chats.map(x => chatItem(x)).join("")}
              ${p.instructions ? "" : `<button type="button" class="cc-proj-hint" data-proj-act="instr" data-id="${escapeAttr(p.id)}">Add instructions Saathi follows here</button>`}
            </div>` : ""}
          </div>`;
        }).join("") : `<p class="cc-list-empty cc-proj-empty">Group chats by topic. Saathi follows each project's instructions.</p>`}
      </div>`;
    const day = 86400000;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const today = start.getTime();
    const groups = [["Pinned", []], ["Today", []], ["Yesterday", []], ["Previous 7 days", []], ["Previous 30 days", []], ["Older", []]];
    for (const x of all) {
      if (inProject(x)) continue;          // listed under its project
      const t = x.updatedAt || x.createdAt || 0;
      const g = x.pinned ? 0 : t >= today ? 1 : t >= today - day ? 2 : t >= today - 7 * day ? 3 : t >= today - 30 * day ? 4 : 5;
      groups[g][1].push(x);
    }
    return projHtml + groups.filter(([, xs]) => xs.length).map(([name, xs]) => `
      <div class="cc-group">
        <h2 class="cc-group-name">${name}</h2>
        ${xs.map(x => chatItem(x)).join("")}
      </div>`).join("") + (archived.length ? `
      <details class="cc-group cc-archived">
        <summary class="cc-group-name">Archived (${archived.length})</summary>
        ${archived.map(x => chatItem(x)).join("")}
      </details>` : "");
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
    if (messagesEl) paintList(messagesEl, renderMessages());
  }

  function renderMessages() {
    if (!chatLog.length) {
      return `
        <div class="cc-empty">
          <h2 class="cc-empty-title">What do you want to understand today?</h2>
          <div class="cc-starters">
            ${STARTER_QUESTIONS.map(q => `<button type="button" class="cc-starter" data-q="${escapeAttr(q)}">${escapeHtml(q)}</button>`).join("")}
          </div>
          ${isPreview() ? `<div class="cc-guide-wrap">${guideCompactHtml()}</div>` : ""}
        </div>
      `;
    }
    return bubbleOrder(chatLog).map(m => renderBubble(m)).join("") +
      (m_pending ? renderTyping() : "");
  }
}

let m_pending = false;
let m_abortController = null;
const openProjects = new Set();   // projects expanded in the sidebar
const collapsed = new Set();      // ...and ones the user closed
let sideQuery = "";
let drawerOpen = false;
let sidebarHidden = false;
let cleanupSide = null;

// ---- Messages ------------------------------------------------------------------
// Preview accounts (isPreview) get the ChatGPT-style controls: edit a question,
// regenerate an answer, ‹ 1/2 › versions (chatBranches.js), feedback,
// cards from slash commands (chatCards.js). Everyone else sees the same
// chat as before.

const I = {
  copy: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="3"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  edit: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  regen: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  up: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v11H4V10z"/><path d="M7 10l4-8a3 3 0 0 1 3 3v4h5.5a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 18.2 21H7"/></svg>',
  down: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V3h3v11z"/><path d="M17 14l-4 8a3 3 0 0 1-3-3v-4H4.5a2 2 0 0 1-2-2.3l1.3-8A2 2 0 0 1 5.8 3H17"/></svg>',
};

// Preview: the stored order IS the conversation (branches need it). Others:
// displayOrder() repairs pre-19-Oct out-of-order pairs, as before.
function bubbleOrder(messages) {
  return isPreview() ? (messages || []) : displayOrder(messages);
}

function verNav(i) {
  const b = branchInfo(chatLog, i);
  if (!b) return "";
  return `<span class="cc-ver" role="group" aria-label="Version ${b.cur} of ${b.n}">
    <button type="button" class="cc-act cc-ver-btn" data-ver="${i}" data-dir="-1" aria-label="Previous version" ${b.cur === 1 ? "disabled" : ""}>&lsaquo;</button>
    <span class="cc-ver-n">${b.cur}/${b.n}</span>
    <button type="button" class="cc-act cc-ver-btn" data-ver="${i}" data-dir="1" aria-label="Next version" ${b.cur === b.n ? "disabled" : ""}>&rsaquo;</button>
  </span>`;
}

function renderBubble(m) {
  const streamAttr = m.streaming ? ` data-streaming="1"` : "";
  const preview = isPreview();
  const i = preview ? chatLog.indexOf(m) : -1;
  if (m.role === "user") {
    const acts = preview && i >= 0 && !m.streaming ? `
      <div class="cc-actions-row cc-actions-user">
        ${verNav(i)}
        <button type="button" class="cc-act" data-copy aria-label="Copy message">${I.copy}</button>
        <button type="button" class="cc-act" data-edit="${i}" aria-label="Edit message">${I.edit}<span>Edit</span></button>
      </div>` : "";
    return `<div class="cc-row cc-row-user"${streamAttr} data-i="${i}"><div class="cc-user-col">${m.chart ? chartCard(m.chart) : ""}<div class="cc-bubble cc-user"><span class="msg-body">${escapeHtml(m.text)}</span></div>${acts}</div></div>`;
  }
  const done = !(m.streaming || m.status || !m.text);
  const actions = !done ? "" : preview && i >= 0 ? `
    <div class="cc-actions-row">
      ${verNav(i)}
      <button type="button" class="cc-act" data-copy aria-label="Copy reply">${I.copy}<span>Copy</span></button>
      <button type="button" class="cc-act" data-regen="${i}" aria-label="Regenerate reply">${I.regen}</button>
      <button type="button" class="cc-act ${m.fb === 1 ? "is-on" : ""}" data-fb="1" data-idx="${i}" aria-pressed="${m.fb === 1}" aria-label="Good reply">${I.up}</button>
      <button type="button" class="cc-act ${m.fb === -1 ? "is-on" : ""}" data-fb="-1" data-idx="${i}" aria-pressed="${m.fb === -1}" aria-label="Bad reply">${I.down}</button>
    </div>` : `
    <div class="cc-actions-row">
      <button type="button" class="cc-act" data-copy aria-label="Copy reply">${I.copy}<span>Copy</span></button>
    </div>`;
  const card = m.card ? cardHtml(m.card) : "";
  const body = m.status ? statusHtml(m.text) : renderMarkdown(hideChartMarkers(m.text));
  // A command card already shows its text summary (what the AI and share
  // links read), so that text is for screen readers only. A chart Saathi
  // put under an answer (cardWithText) goes below the answer.
  const textCls = card && !m.cardWithText ? "cc-bubble cc-bot sr-only" : "cc-bubble cc-bot";
  // A streaming reply starts empty while the model thinks (about 3 s at high
  // effort). It used to render as nothing and hide the typing dots, so the
  // chat looked frozen until the first word arrived.
  const textHtml = m.text ? `<div class="${textCls}"><span class="msg-body">${body}</span></div>`
    : m.streaming ? `<div class="cc-bubble cc-bot"><span class="msg-body">${statusHtml("Thinking…")}</span></div>` : "";
  return `<div class="cc-row cc-row-bot"${streamAttr} data-i="${i}"><div class="cc-bot-col">${m.cardWithText ? textHtml + card : card + textHtml}${actions}</div></div>`;
}

// ---- Scrolling -------------------------------------------------------------------
// The list follows new text only while the reader is at the bottom
// (`_follow`, kept by the scroll listener in render()). Sending a message
// always returns to the bottom. Repaints keep the reader's place.
function composerHint() {
  return isPreview() ? "Ask Saathi anything, or type / for tools" : "Ask Saathi anything";
}
function stickBottom(el, force = false) {
  if (!el) return;
  if (force) el._follow = true;
  if (el._follow !== false) el.scrollTop = el.scrollHeight;
}
function paintList(el, html) {
  const top = el.scrollTop;
  el.innerHTML = html;
  if (el._follow !== false) el.scrollTop = el.scrollHeight;
  else el.scrollTop = top;
  afterPaint(el);
}

// Cards draw after paint; their "ask" buttons send a question. A card grows
// when its chart arrives, so the list re-sticks to the bottom as it does.
function afterPaint(el) {
  if (!el) return;
  if (typeof ResizeObserver === "function") {
    const ro = el._ro || (el._ro = new ResizeObserver(() => stickBottom(el)));
    el.querySelectorAll(".ss-card").forEach((c) => ro.observe(c));
  }
  if (!isPreview()) return;
  hydrateCards(el, { onAsk: askFromCard, onRun: askFromCard, onFill: fillComposer });
}
// The full command guide in a dialog (sidebar "Commands guide", and "What
// each does" on the empty chat's compact row).
function openGuide() {
  openModal(`<div class="cc-modal-head"><h2>Commands</h2><button type="button" class="cc-x" data-close aria-label="Close">&times;</button></div>${guideHtml()}`, (box, close) => {
    box.classList.add("cc-modal-guide");
    hydrateCards(box, {
      onRun: (q) => { close(); askFromCard(q); },
      onFill: (t) => { close(); fillComposer(t); },
    });
  });
}
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-open-guide]") && document.getElementById("chat-messages")) { e.preventDefault(); openGuide(); }
});


function fillComposer(text) {
  const input = document.getElementById("chat-input");
  if (!input) return;
  input.value = text;
  input.focus();
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new Event("input"));
}
function askFromCard(q) {
  const input = document.getElementById("chat-input");
  const form = document.getElementById("chat-form");
  if (!input || !form || m_pending) return;
  input.value = q;
  form.requestSubmit();
}

function cloudSave(now = false) {
  if (!isPreview()) return;
  try { pushThread(getActiveSession(sessionsData), { now }); } catch {}
}

// The cloud copy (chat_threads) wins for every chat it has; chats only this
// device has are uploaded. Returns true when anything on screen changed.
let _cloudSyncing = null;
function syncFromCloud() {
  if (_cloudSyncing) return _cloudSyncing;
  _cloudSyncing = (async () => {
    const threads = await pullThreads();
    let changed = false;
    const byId = new Map(sessionsData.sessions.map((x) => [x.id, x]));
    const cloudIds = new Set();
    for (const t of threads) {
      cloudIds.add(t.id);
      const local = byId.get(t.id);
      if (repairTurnOrder(t.messages)) pushThread(t);   // stored flipped before 19 Oct
      if (t.trashed) {
        if (local) { deleteSessionById(sessionsData, t.id); changed = true; }
        continue;
      }
      // A chat rebuilt from the flat coach_messages log (fromLog) never beats
      // the cloud document: it has no cards or versions, and before 19 Oct
      // its order came from insert times. Uploading it is how replies ended
      // up above their questions in chat_threads.
      const cloudNewestTs = Math.max(0, ...t.messages.map((m) => Number(m?.ts) || 0));
      const hasUnuploadedUser = local?.messages?.some((m) => m.role === "user" && (m.ts || 0) > cloudNewestTs);
      if (local && !local.fromLog
          && ((local.updatedAt || 0) > t.updatedAt + 2000 || hasUnuploadedUser)
          && (local.messages || []).length >= t.messages.length) {
        pushThread(local);            // this device is newer: send it up
        continue;
      }
      if (local) delete local.fromLog;
      const next = { ...(local || {}), id: t.id, title: t.title, pinned: t.pinned, archived: t.archived, folder: t.folder,
        messages: t.messages, pruned: t.pruned, createdAt: t.createdAt, updatedAt: t.updatedAt };
      if (local) {
        if (JSON.stringify(local.messages) !== JSON.stringify(t.messages) || local.archived !== t.archived || local.pinned !== t.pinned || local.title !== t.title || (local.folder || null) !== (t.folder || null)) {
          const moved = (local.folder || null) !== (t.folder || null);
          Object.assign(local, next);
          // The device's meta copy would put the old project back on reload.
          if (moved) setFolder(sessionsData, t.id, t.folder);
          changed = true;
        }
      } else { sessionsData.sessions.push(next); changed = true; }
    }
    for (const x of sessionsData.sessions) {
      if (!cloudIds.has(x.id) && (x.messages || []).length) { repairTurnOrder(x.messages); pushThread(x); }
    }
    if (changed) {
      saveSessions(sessionsData);
      rebindActiveChatLog();
    }
    return changed;
  })().finally(() => { setTimeout(() => { _cloudSyncing = null; }, 0); });
  return _cloudSyncing;
}

// A typed question or a slash command.
async function produceReply(text) {
  if (isPreview() && isCommand(text)) return runCommandReply(text);
  return sendAndReply(text);
}

async function runCommandReply(text) {
  m_pending = true;
  const sess = getActiveSession(sessionsData);
  const typing = document.getElementById("chat-messages");
  typing?.insertAdjacentHTML("beforeend", renderTyping());
  try {
    const res = await runCommand(text);
    if (res.text == null && res.ask) { m_pending = false; return sendAndReply(res.ask); }
    sess.messages.push({ role: "assistant", text: res.text || "I didn't catch that command. Type /help to see them.", card: res.card || undefined, ts: nextTs(sess.messages) });
    sess.updatedAt = Date.now();
    saveChat();
    const reply = sess.messages.at(-1);
    logChatTurn({ userText: "", assistantText: reply?.text || "", model: "command", sessionId: sess.id, surface: "chat_page", replyTs: reply?.ts });
  } catch (e) {
    console.warn("[chat] command failed:", e);
    const replyText = "That command didn't work just now. Try again in a moment.";
    const reply = { role: "assistant", text: replyText, ts: nextTs(sess.messages) };
    sess.messages.push(reply);
    saveChat();
    logChatTurn({ userText: "", assistantText: replyText, model: "command-error", sessionId: sess.id, surface: "chat_page", replyTs: reply.ts });
  } finally {
    m_pending = false;
  }
}

// ---- Export --------------------------------------------------------------------
function chatMarkdown(sess) {
  const lines = [`# ${sess.title || "StockSaathi chat"}`, "", `_Exported from StockSaathi on ${new Date().toLocaleString("en-IN")}_`, ""];
  for (const m of sess.messages || []) {
    if (!m?.text || m.status) continue;
    lines.push(m.role === "user" ? `**You:** ${m.text}` : `**Saathi:** ${m.text}`, "");
  }
  lines.push("---", "Practice only, not investment advice.");
  return lines.join("\n");
}
function downloadText(name, text, type = "text/markdown") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: type + ";charset=utf-8" }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function printChat(sess) {
  const w = window.open("", "_blank", "noopener=no");
  if (!w) { toast({ kind: "info", message: "Allow pop-ups to save as PDF." }); return; }
  const body = (sess.messages || []).filter((m) => m?.text && !m.status).map((m) =>
    `<div class="m ${m.role}"><b>${m.role === "user" ? "You" : "Saathi"}</b>${m.role === "user" ? `<p>${escapeHtml(m.text)}</p>` : renderMarkdown(m.text)}</div>`).join("");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(sess.title || "StockSaathi chat")}</title>
    <style>body{font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 20px;color:#141414}h1{font-size:22px}
    .m{margin:0 0 18px}.m b{display:block;font-size:12px;color:#5B6170;margin-bottom:2px}.m.user p{background:#E6F7F1;border-radius:12px;padding:8px 12px;margin:0}
    footer{margin-top:32px;font-size:12px;color:#5B6170}</style></head><body><h1>${escapeHtml(sess.title || "StockSaathi chat")}</h1>${body}
    <footer>StockSaathi · practice only, not investment advice · ${escapeHtml(new Date().toLocaleString("en-IN"))}</footer></body></html>`);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 300);
}

// ---- Modals (share, shared links) ---------------------------------------------
function openModal(html, onWire) {
  document.querySelector(".cc-modal-wrap")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "cc-modal-wrap";
  wrap.innerHTML = `<div class="cc-modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(wrap);
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onEsc); };
  const onEsc = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onEsc);
  onBackdropClick(wrap, close);
  wrap.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
  onWire?.(wrap.querySelector(".cc-modal"), close);
  wrap.querySelector("button, input")?.focus();
}

async function openShare(sess) {
  const existing = (await listShares()).find((x) => x.thread_id === sess.id);
  openModal(`
    <div class="cc-modal-head"><h2>Share this chat</h2><button type="button" class="cc-x" data-close aria-label="Close">&times;</button></div>
    <p class="cc-modal-sub">Anyone with the link can read this chat as it is now. Messages you add later stay private until you update the link.</p>
    <label class="cc-check"><input type="checkbox" id="cc-hide-amt" ${existing?.hide_amounts ? "checked" : ""}> Hide ₹ amounts (your portfolio numbers)</label>
    <div class="cc-link-row" ${existing ? "" : "hidden"}><input id="cc-link" readonly value="${existing ? escapeAttr(`${location.origin}/share/${existing.id}`) : ""}" aria-label="Share link"><button type="button" class="cc-btn" id="cc-copy-link">Copy</button></div>
    <div class="cc-modal-actions">
      ${existing ? `<button type="button" class="cc-btn cc-btn-ghost" id="cc-unshare">Stop sharing</button>` : ""}
      <button type="button" class="cc-btn cc-btn-primary" id="cc-make-link">${existing ? "Update link" : "Create link"}</button>
    </div>`, (box, close) => {
    let shareId = existing?.id || null;
    box.querySelector("#cc-make-link").addEventListener("click", async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try {
        const r = await upsertShare({ threadId: sess.id, title: sess.title, messages: sess.messages, hideAmounts: box.querySelector("#cc-hide-amt").checked, existingId: shareId });
        shareId = r.id;
        box.querySelector(".cc-link-row").hidden = false;
        box.querySelector("#cc-link").value = r.url;
        b.textContent = "Update link";
        try { await navigator.clipboard.writeText(r.url); toast({ kind: "success", message: "Link copied" }); } catch {}
      } catch (err) { toast({ kind: "error", message: err?.message || "Couldn't create the link." }); }
      b.disabled = false;
    });
    box.querySelector("#cc-copy-link").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(box.querySelector("#cc-link").value); toast({ kind: "success", message: "Link copied" }); } catch {}
    });
    box.querySelector("#cc-unshare")?.addEventListener("click", async () => {
      if (await revokeShare(shareId)) { toast({ kind: "success", message: "Link turned off" }); close(); }
    });
  });
}

async function openSharedLinks() {
  const rows = await listShares();
  openModal(`
    <div class="cc-modal-head"><h2>Shared links</h2><button type="button" class="cc-x" data-close aria-label="Close">&times;</button></div>
    ${rows.length ? `<ul class="cc-share-list">${rows.map((r) => `<li data-id="${escapeAttr(r.id)}"><a href="/share/${encodeURIComponent(r.id)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a>
      <span>${escapeHtml(new Date(r.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }))} · ${r.views} view${r.views === 1 ? "" : "s"}</span>
      <button type="button" class="cc-btn cc-btn-ghost" data-revoke="${escapeAttr(r.id)}">Turn off</button></li>`).join("")}</ul>`
      : `<p class="cc-modal-sub">You haven't shared any chats.</p>`}`, (box) => {
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-revoke]");
      if (!b) return;
      b.disabled = true;
      if (await revokeShare(b.dataset.revoke)) b.closest("li")?.remove();
    });
  });
}

// ---- Starter questions from today's market and news ----------------------
// Built from data the site already caches (the CDN-cached NSE snapshot and the
// news feed), so they cost no AI call and no database read. Two from the
// biggest moves among large companies, two from the latest headlines, two
// evergreen. Falls back to the fixed list if either source is unavailable.
let _starters = null;
async function liveStarters() {
  if (_starters) return _starters;
  const out = [];
  try {
    const snap = await (await fetch("/api/ai?op=search-snapshot&v=3")).json();
    const col = (n) => snap.cols.indexOf(n);
    const [S, D, MC] = [col("s"), col("d"), col("mc")];
    const big = snap.rows.filter(r => r[MC] >= 20000 && typeof r[D] === "number");
    const when = snap.asOf ? new Date(snap.asOf + "T12:00:00+05:30").toLocaleDateString("en-IN", { weekday: "long" }) : "";
    const isToday = snap.asOf === new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const day = isToday ? "today" : `on ${when}`;
    const up = big.slice().sort((a, b) => b[D] - a[D])[0];
    const down = big.slice().sort((a, b) => a[D] - b[D])[0];
    if (up && up[D] > 1) out.push(`Why did ${up[S]} rise ${up[D].toFixed(1)}% ${day}?`);
    if (down && down[D] < -1) out.push(`Why did ${down[S]} fall ${Math.abs(down[D]).toFixed(1)}% ${day}?`);
  } catch (e) { console.warn("[chat] starters: snapshot", e); }
  try {
    const news = await getNews({ limit: 30 });
    const picked = (news || [])
      .filter(n => n?.headline && n.headline.length < 90)
      .slice(0, 12)
      .sort((a, b) => (b.sentiment !== "neutral") - (a.sentiment !== "neutral"))
      .slice(0, 2);
    for (const n of picked) {
      const h = n.headline.replace(/\s+/g, " ").trim();
      out.push(`What does this mean: "${h.length > 70 ? h.slice(0, 68).trimEnd() + "…" : h}"`);
    }
  } catch (e) { console.warn("[chat] starters: news", e); }
  if (out.length < 2) return (_starters = STARTER_QUESTIONS);
  out.push("How does compounding work?", "How do I spot a finfluencer scam?");
  return (_starters = out.slice(0, 6));
}
async function fillStarters(main, ask) {
  const box = main.querySelector(".cc-starters");
  if (!box) return;
  const qs = await liveStarters();
  if (!main.contains(box)) return;
  box.innerHTML = qs.map(q => `<button type="button" class="cc-starter" data-q="${escapeAttr(q)}">${escapeHtml(q)}</button>`).join("");
  box.querySelectorAll("[data-q]").forEach(b => b.addEventListener("click", () => ask(b.dataset.q)));
}

// ---- Chart reading -------------------------------------------------------
// "Read the 3-month chart of TCS": the app fetches the daily NSE closes
// itself, works out the plain facts (move, range, averages, biggest day,
// volume) and puts them in the question, so Saathi reads the real chart and
// cannot guess. The chart is attached to the student's message as a card.
const CHART_RE = /\b(chart|charts|graph|trend|technicals?|support|resistance|moving averages?)\b/i;
const CHART_SKIP = /^(read|the|a|an|month|months|mo|year|years|yr|week|weeks|chart|charts|of|for|me|my|show|explain|stock|stocks|share|shares|price|trend|graph|and|what|is|how|does|do|look|looks|last|past|this|in|on|please|can|you|give|technical|technicals|support|resistance|moving|average|averages|day|days|daily|analysis|analyse|analyze)$/i;
function chartSymbol(text) {
  const words = String(text).match(/[A-Za-z][A-Za-z0-9&\-]{1,19}/g) || [];
  for (const w of words) {
    if (CHART_SKIP.test(w)) continue;
    const inst = getInstrument(w.toUpperCase());
    if (inst && inst.symbol && !inst._stub) return inst.symbol;
  }
  // By company name: "Infosys" -> INFY, "HDFC Bank" -> HDFCBANK.
  const t = String(text).toLowerCase();
  let best = null;
  for (const st of STOCKS || []) {
    const name = String(st.name || "").toLowerCase().replace(/\b(ltd|limited|corporation|industries|company|india)\b\.?/g, "").replace(/\s+/g, " ").trim();
    if (name.length >= 3 && t.includes(name) && (!best || name.length > best.n)) best = { sym: st.symbol, n: name.length };
  }
  return best ? best.sym : null;
}
function chartRange(text) {
  const m = String(text).match(/(\d{1,2})\s*-?\s*(week|wk|month|mo|year|yr)/i);
  if (!m) return { range: "3mo", label: "3-month" };
  const n = +m[1], u = m[2].toLowerCase();
  if (u.startsWith("w") || (u.startsWith("mo") && n <= 1)) return { range: "1mo", label: "1-month" };
  if (u.startsWith("mo") && n <= 3) return { range: "3mo", label: "3-month" };
  if (u.startsWith("mo") && n <= 6) return { range: "6mo", label: "6-month" };
  return { range: "1y", label: "1-year" };
}
async function chartContext(text, messages) {
  if (!CHART_RE.test(text)) return "";
  const sym = chartSymbol(text);
  if (!sym) return "";
  const { range, label } = chartRange(text);
  let bars = [];
  try {
    const r = await fetch(`/api/history?symbol=${encodeURIComponent(sym)}&range=${range}&interval=1d`);
    const j = await r.json();
    bars = (j.ohlc || []).filter(b => b && b.c > 0 && b.t);
  } catch { return ""; }
  if (bars.length < 15) return "";
  const rs = (p) => (p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const day = (t) => new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  const first = bars[0], last = bars[bars.length - 1];
  const chg = (last.c - first.c) / first.c * 100;
  let hi = bars[0], lo = bars[0], big = null, ups = 0;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].h > hi.h) hi = bars[i];
    if (bars[i].l < lo.l) lo = bars[i];
    if (i) {
      const d = (bars[i].c - bars[i - 1].c) / bars[i - 1].c * 100;
      if (d > 0) ups++;
      if (!big || Math.abs(d) > Math.abs(big.d)) big = { d, t: bars[i].t };
    }
  }
  const avg = (n) => { const xs = bars.slice(-n); return xs.reduce((a, b) => a + b.c, 0) / xs.length; };
  const a20 = avg(20), a50 = bars.length >= 50 ? avg(50) : null;
  const vol = (xs) => xs.reduce((a, b) => a + (b.v || 0), 0) / Math.max(1, xs.length);
  const volRatio = vol(bars.slice(-5)) / Math.max(1, vol(bars.slice(0, -5)));
  const fromHi = (last.c - hi.h) / hi.h * 100;
  const u = [...messages].reverse().find(m => m.role === "user");
  if (u) {
    const step = Math.max(1, Math.floor(bars.length / 80));
    u.chart = {
      sym, label,
      pts: bars.filter((_, i) => i % step === 0 || i === bars.length - 1).map(b => b.c),
      chg: +chg.toFixed(2), last: rs(last.c), from: day(first.t), to: day(last.t),
    };
  }
  return `

CHART DATA: ${sym}, ${label} daily chart from NSE, ${day(first.t)} to ${day(last.t)}, ${bars.length} trading sessions.
- First close (${day(first.t)}): ₹${rs(first.c)}. Latest close (${day(last.t)}): ₹${rs(last.c)}. Change over the period: ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%.
- Highest price: ₹${rs(hi.h)} on ${day(hi.t)}. Lowest price: ₹${rs(lo.l)} on ${day(lo.t)}. The latest close is ${Math.abs(fromHi).toFixed(1)}% below the period high.
- 20-day average close: ₹${rs(a20)}; the latest close is ${last.c >= a20 ? "above" : "below"} it.${a50 ? ` 50-day average close: ₹${rs(a50)}; the latest close is ${last.c >= a50 ? "above" : "below"} it.` : ""}
- Up days: ${ups} of ${bars.length - 1}. Biggest one-day move: ${big.d >= 0 ? "+" : ""}${big.d.toFixed(2)}% on ${day(big.t)}.
- Average volume in the last 5 sessions is ${volRatio.toFixed(1)}x the period's average.

HOW TO ANSWER: this is the chart the student is looking at; it is attached above their message. Read it for them using only these numbers. Say what the overall shape was (rise, fall, sideways, or a dip and recovery), where the high and low came, and what being above or below the averages means, in plain words for a teenager, in 4 to 6 short sentences. Do not say you cannot see the chart, do not offer to look anything up, no predictions, no buy or sell views, no price targets, and do not end with a question about what happens next. Write the answer in ${getState()?.settings?.hinglish ? "Hinglish (Hindi in Roman script), keeping finance terms in English" : "English"}.`;
}

export function chartCard(c) {
  const pts = c.pts || [];
  if (pts.length < 2) return "";
  const W = 300, H = 72, min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const xy = pts.map((v, i) => `${(i / (pts.length - 1) * W).toFixed(1)},${(H - 4 - (v - min) / span * (H - 8)).toFixed(1)}`);
  const up = c.chg >= 0;
  return `<figure class="cc-chart ${up ? "is-up" : "is-down"}" aria-label="${escapeAttr(c.sym)} ${escapeAttr(c.label || "")} chart, ${c.chg}% from ${escapeAttr(c.from)} to ${escapeAttr(c.to)}">
    <figcaption><strong>${escapeHtml(c.sym)}</strong>${c.last ? `<b>₹${escapeHtml(c.last)}</b>` : ""}<span>${up ? "+" : ""}${c.chg}%</span></figcaption>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${xy.join(" ")}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>
    <div class="cc-chart-foot"><em>${escapeHtml(c.from)} – ${escapeHtml(c.to)}</em><a href="/stocks/${encodeURIComponent(c.sym)}">Full chart</a></div>
  </figure>`;
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
export function renderMarkdown(text) {
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
  const sess = getActiveSession(sessionsData);
  if (sess) delete sess.fromLog;   // this device is writing it now
  const message = { role: "user", text, ts: nextTs(chatLog) };
  chatLog.push(message);
  saveChat();
  return message;
}
function pushAssistant(text) {
  chatLog.push({ role: "assistant", text, ts: nextTs(chatLog) });
  saveChat();
}

async function sendAndReply(userText) {
  m_pending = true;
  m_abortController = new AbortController();
  const signal = m_abortController.signal;

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
  const outer = chatHost();
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
      paintList(messagesEl, bubbleOrder(ownerMessages).map(renderBubble).join("") +
        (m_pending && !ownerMessages.at(-1)?.streaming ? renderTyping() : ""));
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
      paintList(el, bubbleOrder(active.messages).map(renderBubble).join(""));
    } catch (e) {
      console.warn("[chat] finalPaint failed:", e);
    }
  };

  const restoreForm = () => {
    // Re-read from the DOM rather than trusting the captured refs: a
    // re-render between send and completion replaces these nodes, and a
    // stale ref here is how the composer ends up stuck on "thinking".
    const el = chatHost();
    const shellNow = el?.querySelector(".composer-shell");
    shellNow?.classList.remove("is-busy");
    shellNow?.querySelector(".composer-dots")?.remove();

    const inputNow = el?.querySelector("#chat-input") || input;
    if (inputNow) {
      inputNow.removeAttribute("readonly");
      inputNow.removeAttribute("disabled");
      inputNow.placeholder = composerHint();
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
  // Preserve full session history without arbitrary truncation
  const messages = chatLog.map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: withLookupProvenance(
      m.role === "user" && m.chartText ? `${m.text}\n\n[The app attached this chart to the question.]${m.chartText}` : m.text,
      m.lookupProvenance,
    ),
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
      const replyText = offTopicRedirect(userText);
      const reply = { role: "assistant", text: replyText, ts: nextTs(ownerMessages) };
      ownerMessages.push(reply);
      if (isOwnerActive()) chatLog = ownerMessages;
      saveSessions(sessionsData);
      logChatTurn({ userText: "", assistantText: replyText, model: "off-topic", sessionId: ownerSession.id, surface: "chat_page", replyTs: reply.ts });
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

  // A chart question carries its own data (fetched here, attached to the
  // question), so it skips the tool round and is answered from that data.
  const chartBlock = await chartContext(userText, ownerMessages);
  if (chartBlock) {
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    if (lastUser) lastUser.content = `${lastUser.content}\n\n[The app attached this chart to the question.]${chartBlock}`;
    // Keep the numbers with the question so follow-ups use them, not guesses.
    const owner = [...ownerMessages].reverse().find(m => m.role === "user");
    if (owner) owner.chartText = chartBlock.split("\n\nHOW TO ANSWER")[0];
  }
  const wantTools = !chartBlock && needsLiveData(userText, chatLog.slice(-8, -1));
  // C28: the language rule in runtimeFacts holds better repeated last in the
  // prompt. The Hinglish switch picks the language; nothing guesses it from
  // the user's words (that made the coach flip language turn to turn).
  const turnLang = getState().settings.hinglish
    ? `

# THIS TURN: LANGUAGE
Hinglish mode is on. Reply in casual Hinglish: mix everyday Roman Hindi with natural English words and phrases. Keep finance terms like P/E, SIP, NAV, price, profit, company and stock in English. Avoid formal Hindi translations such as 'tulna', 'ummeed', 'nirnay', 'nivesh', 'laabh', 'saalana', 'keemat' and 'moolya'.`
    : `

# THIS TURN: LANGUAGE
Reply in English.`;
  // Preview: Saathi can put an interactive chart under any answer (chatCards.js).
  const chartNote = isPreview() ? CHART_TOOL_NOTE + projectNote(ownerSession.folder) : "";

  if (wantTools) {
    // Tool-use path: non-streaming, standard runAgent with TOOLS.
    reRenderOuter();   // show typing indicator
    let replyText = null;
    let errorText = null;
    const lookupProvenance = [];
    const collectLookupStep = (step) => {
      if (step?.action === "tool_results") {
        lookupProvenance.push(...normalizeLookupProvenance(step.lookups));
      }
    };
    // Live bubble: a status line while tools run ("Checking TCS price…"),
    // then the answer as it streams. The finished reply replaces its text.
    let live = null;
    const showLive = (t, isStatus) => {
      if (!live) {
        live = { role: "assistant", text: "", ts: nextTs(ownerMessages), streaming: true };
        ownerMessages.push(live);
        reRenderOuter();
      }
      // Status lines show at once; answer text streams directly via requestAnimationFrame.
      liveTarget = isStatus ? "" : t;
      live.text = t || "";
      liveStatus = !!isStatus;
      live.status = liveStatus;
      if (isStatus) {
        paintLive();
      } else if (!liveRaf) {
        liveRaf = true;
        requestAnimationFrame(() => {
          liveRaf = false;
          paintLive();
        });
      }
    };
    let liveTarget = "", liveRaf = false, liveStatus = false;
    const paintLive = () => {
      if (!isOwnerActive() || !live) return;
      const bubble = outer?.querySelector('#chat-messages [data-streaming="1"] .msg-body');
      if (!bubble) { reRenderOuter(); return; }
      bubble.innerHTML = live.status ? statusHtml(live.text) : renderMarkdown(hideChartMarkers(live.text));
      const msgs = outer?.querySelector("#chat-messages");
      stickBottom(msgs);
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
    const system = `${SYSTEM_PROMPT}\n\n# TOOL USE\nYou have tools for live data: get_stock_price, get_crypto_price, search_stocks, get_market_news, get_user_portfolio, get_trade_history, get_watchlist, get_limit_orders, get_fundamentals. USE them whenever the user asks about any specific stock, crypto, market state, company fundamentals (profit, EPS, ROE, P/E, debt, market cap), or their portfolio. Never guess numbers — always call the tool.\n\nCRITICAL: Call tools via the STRUCTURED tool_calls API only. NEVER write literal text like 'CALL search_stocks(...)' or '[Tool call: ...]' or fenced ` + "```tool_calls```" + ` JSON in your visible response. Those are internal scaffolding the user must never see. If you want to call a tool, emit the tool_call JSON block and let the system handle it. Your visible reply either (a) answers the user's question with real data you just received from a tool, or (b) says you'll look it up — never describes the mechanics of looking it up.\n\n${runtimeFacts(marketStatus(), userText)}\n\n${dossier}\n\n# TONE\nKeep replies conversational and short by default (1–3 sentences). Only go longer when the user asks for explanation or depth.` + newsBlock + discoveryNudge + chartNote + turnLang;
    try {
      replyText = await runAgent({
        apiKey: state.settings.llmApiKey || null,
        system,
        messages,
        profile: "fast",
        signal,
        onText: (t) => showLive(t || "", false),
        onStep: (st) => {
          collectLookupStep(st);
          if (st.action === "tool_calls") showLive(toolStatus(st.calls), true);
          else if (st.action === "figure_check") showLive("Double-checking the numbers…", true);
        },
      });
    } catch (e) {
      if (!signal.aborted) console.warn("coach chat tool path error:", e);
      errorText = signal.aborted
        ? "No worries — I stopped that reply."
        : "Couldn't reach Saathi right now. Try again in a moment.";
    }
    if (signal.aborted) errorText = "No worries — I stopped that reply.";
    // Flush the last scheduled live-text paint before replacing it with the
    // final reply. The timeout also releases the send button in background tabs.
    if (liveRaf) await new Promise((done) => {
      const timeout = setTimeout(done, 2000);
      requestAnimationFrame(() => { clearTimeout(timeout); done(); });
    });
    m_pending = false;
    m_abortController = null;
    restoreForm();
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
          onStep: collectLookupStep,
        }), 12_000);
        const cleanRetry = stripScaffolding(retry);
        const retryStillBad = looksLikeLookupOffer(cleanRetry) || looksLikeFetchPromise(cleanRetry)
          || looksLikePricelessList(cleanRetry, userText);
        if (cleanRetry && cleanRetry.trim() && !retryStillBad) cleanedReply = cleanRetry;
      } catch (e) { console.warn("[chat] lookup-offer retry failed:", e?.message || e); }
    }
    cleanedReply = await finishReply(cleanedReply, userText, system, messages, collectLookupStep);
    let finalText = (cleanedReply && cleanedReply.trim()) ? cleanedReply : (errorText || "Saathi couldn't answer that. Try rephrasing or asking again.");
    const ex = extractChartMarker(finalText);
    finalText = ex.text || finalText;
    const chartExtra = ex.card && isPreview() ? { card: ex.card, cardWithText: true } : {};
    // Stamp the reply just after ITS question, not when it finished: chats
    // are re-sorted by ts on sync, so a slow answer used to land below a
    // later question's answer.
    let qIdx = -1;
    for (let i = ownerMessages.length - 1; i >= 0; i--) {
      if (ownerMessages[i]?.role === "user" && ownerMessages[i].text === userText) { qIdx = i; break; }
    }
    const replyTs = qIdx >= 0 ? (ownerMessages[qIdx].ts || Date.now()) + 1 : Date.now();
    if (live) {
      live.text = finalText; live.streaming = false; live.status = false; live.ts = replyTs;
      Object.assign(live, chartExtra);
      const provenance = normalizeLookupProvenance(lookupProvenance);
      if (provenance.length) live.lookupProvenance = provenance;
    }
    else if (qIdx >= 0) ownerMessages.splice(qIdx + 1, 0, {
      role: "assistant", text: finalText, ts: replyTs, ...chartExtra,
      ...(lookupProvenance.length ? { lookupProvenance: normalizeLookupProvenance(lookupProvenance) } : {}),
    });
    else ownerMessages.push({
      role: "assistant", text: finalText, ts: replyTs, ...chartExtra,
      ...(lookupProvenance.length ? { lookupProvenance: normalizeLookupProvenance(lookupProvenance) } : {}),
    });
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
        userText: "", assistantText: finalText, model: "gemini-chat",
        sessionId: ownerSession.id, surface: "chat_page",
        userTs: qIdx >= 0 ? ownerMessages[qIdx]?.ts : undefined, replyTs,
        lookupProvenance,
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
  ownerMessages.push({ role: "assistant", text: "", ts: nextTs(ownerMessages), streaming: true });
  reRenderOuter();
  const lookupProvenance = [];
  const collectLookupStep = (step) => {
    if (step?.action === "tool_results") {
      lookupProvenance.push(...normalizeLookupProvenance(step.lookups));
    }
  };

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
    const outerEl = chatHost();
    const streamBubble = outerEl?.querySelector('#chat-messages [data-streaming="1"] .msg-body');
    if (streamBubble) {
      streamBubble.innerHTML = renderMarkdown(hideChartMarkers(displayedText));
      const msgs = outerEl?.querySelector("#chat-messages");
      stickBottom(msgs);
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
  const streamSystem = `${SYSTEM_PROMPT}\n\n${NO_TOOLS_NOTE}\n\n${runtimeFacts(marketStatus(), userText)}\n\n${dossier}\n\n# TONE\nKeep replies conversational and short by default (1–3 sentences). Only go longer when the user asks for explanation or depth.

Answer only the latest message. Do not restate prices or facts from earlier turns unless the user asks for them again.` + chartNote + turnLang;
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
  restoreForm();
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
    const provenance = normalizeLookupProvenance(lookupProvenance);
    if (provenance.length) entry.lookupProvenance = provenance;
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

${runtimeFacts(marketStatus(), userText)}

# THIS TURN
The user asked for data. Call the tools and answer with real numbers. Do NOT ask permission.`;
      const esc = await withDeadline(runAgent({
        apiKey: getState().settings.llmApiKey || null,
        system: sysT, messages, profile: "fast",
        onStep: collectLookupStep,
      }), 12_000);
      const cleanEsc = stripScaffolding(esc);
      if (cleanEsc && cleanEsc.trim()) { entry.text = cleanEsc.trim(); fromStream = false; }
    } else if (!entry.text.trim() && isToolCallOnly(result?.raw)) {
      // Reply was nothing but a tool call: the model decided it needed live
      // data while on the streaming path, which has no tools wired. It was
      // right about needing a tool. Re-run through runAgent rather than
      // telling the user we went quiet.
      const sys = `${SYSTEM_PROMPT}

${runtimeFacts(marketStatus(), userText)}

# TONE
Keep replies conversational and short by default (1–3 sentences).`;
      const retry = await withDeadline(runAgent({
        apiKey: getState().settings.llmApiKey || null,
        system: sys, messages, profile: "fast",
        onStep: collectLookupStep,
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

${runtimeFacts(marketStatus(), userText)}

${dossier}` + (await prefetchNewsBlock(userText)) + `

# THIS TURN
Your earlier draft stated prices, moves or events that were not looked up. Call the tool for every figure you give (get_stock_price for a price or today's move, get_market_news for news), or leave the figure out.` + turnLang;
        const redo = await withDeadline(runAgent({
          apiKey: getState().settings.llmApiKey || null,
          system: toolSys, messages, profile: "fast",
          onStep: collectLookupStep,
        }), 12_000).catch(() => null);
        const cleanRedo = stripScaffolding(redo);
        if (cleanRedo && cleanRedo.trim()) entry.text = cleanRedo.trim();
        else entry.text = dropFigureSentences(entry.text, figs) || entry.text;
      }
    }
    if (!result?.aborted && entry.text && !entry.text.startsWith("Hmm")) {
      entry.text = await finishReply(entry.text, userText, streamSystem, messages, collectLookupStep);
    }
    if (result?.finishReason === "length" && entry && !entry.text.includes("maximum generation limit")) {
      entry.text += "\n\n… [Response reached maximum generation limit. Ask \"continue\" if you'd like more.]";
    }
    {
      const ex = extractChartMarker(entry.text);
      if (ex.text) entry.text = ex.text;
      if (ex.card && isPreview()) { entry.card = ex.card; entry.cardWithText = true; }
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
        userText: "", assistantText: entry.text, model: "gemini-chat",
        sessionId: ownerSession.id, surface: "chat_page",
        userTs: ownerMessages[placeholderIdx - 1]?.ts, replyTs: entry.ts,
        lookupProvenance,
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
