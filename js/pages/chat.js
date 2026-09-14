// =============================================================================
// CHAT — A simple coaching chatbot for teens learning to invest.
// Uses the BYO LLM path (if API key set) or deterministic template responses
// as fallback.
// =============================================================================

import { getState } from "../state.js";
import { getInstrument } from "../data/universe.js";
import { SYSTEM_PROMPT, matchTemplate, isOffTopic, offTopicRedirect, STARTER_QUESTIONS, runtimeFacts, NO_TOOLS_NOTE } from "../coach/persona.js";
import { marketStatus } from "../data/prices.js";
import { runAgent, streamChat, needsLiveData, logChatTurn, stripToolCallScaffolding, isToolCallOnly, looksLikeLookupOffer, looksLikePricelessList } from "../coach/agent.js";
import { buildDossier } from "../coach/dossier.js";
import {
  loadSessions, saveSessions, getActiveSession, setActiveSession,
  createNewSession, deleteSessionById, touchActive, clearActiveMessages,
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
  render();

  // Cross-tab sync: when the storage event handler (see module scope) pulls
  // in fresh sessionsData from another tab, it fires this custom event so
  // the currently-mounted chat page re-renders with the updated state.
  const syncHandler = () => { if (document.getElementById("chat-messages")) render(); };
  document.addEventListener("ss:chat-sessions-sync", syncHandler);
  window.addEventListener("hashchange", () => {
    document.removeEventListener("ss:chat-sessions-sync", syncHandler);
  }, { once: true });

  function render() {
    const state = getState();
    const active = getActiveSession(sessionsData);

    main.innerHTML = `
      <div style="max-width: 760px; margin: 0 auto;">
        <div style="margin-bottom: var(--sp-4);">
          <div class="flex items-center gap-3 wrap">
            <h1 style="margin: 0;">Saathi</h1>
            <div class="chat-session-bar" style="margin-left: auto; display: flex; gap: 8px; align-items: center;">
              <div class="chat-session-picker-wrap" style="position: relative;">
                <button id="chat-session-picker" class="btn btn-ghost btn-sm" type="button" aria-haspopup="listbox" aria-expanded="false" style="max-width: 220px; display: inline-flex; align-items: center; gap: 6px;" title="Switch chat session">
                  <span aria-hidden="true">🗂</span>
                  <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(active.title || "New chat")}</span>
                  <span aria-hidden="true">▾</span>
                </button>
                <div id="chat-session-menu" class="chat-session-menu" hidden role="listbox"></div>
              </div>
              <button id="chat-new-btn" class="btn btn-primary btn-sm" type="button" title="Start a new chat (previous chats are kept)">+ New</button>
            </div>
          </div>
          <p class="muted" style="margin-top: var(--sp-2);">I'm Saathi — your finance coach. Ask anything about money, investing, Indian markets, taxes, behavioral econ, or how a past crash played out. Out of scope: everything else.</p>
        </div>

        <div class="card" style="padding: 0; overflow: hidden;">
          <div id="chat-messages" style="height: 520px; overflow-y: auto; padding: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-3); background: var(--bg-soft);">
            ${renderMessages()}
          </div>

          <form id="chat-form" class="composer">
            <div class="composer-shell ${m_pending ? "is-busy" : ""}">
              ${m_pending
                ? `<span class="composer-dots" aria-live="polite"><span>Saathi is thinking</span><i></i><i></i><i></i></span>`
                : ""}
              <input
                id="chat-input"
                class="composer-input"
                placeholder="${m_pending ? "" : "Ask about SIPs, P/E, crashes, anything…"}"
                autocomplete="off"
                maxlength="500"
                aria-label="Message Saathi"
                ${m_pending ? "disabled" : ""}
              />
              ${m_pending
                ? `<button class="composer-btn is-stop" id="chat-stop" type="button" title="Stop generating" aria-label="Stop generating">&#9632;</button>`
                : `<button class="composer-btn" id="chat-send" type="submit" title="Send" aria-label="Send message">&#8593;</button>`}
            </div>
          </form>
        </div>

        <div class="flex gap-2 wrap" style="margin-top: var(--sp-4);">
          ${STARTER_QUESTIONS.map(q => `<button class="filter-pill" data-q="${escapeAttr(q)}">${escapeHtml(q)}</button>`).join("")}
          <button class="filter-pill" id="chat-clear" style="color: var(--negative);">Clear chat</button>
        </div>
      </div>
    `;

    const input = main.querySelector("#chat-input");
    const form = main.querySelector("#chat-form");
    const messagesEl = main.querySelector("#chat-messages");
    messagesEl.scrollTop = messagesEl.scrollHeight;
    // Desktop: auto-focus so the user can start typing. Mobile: don't —
    // focusing an input pops the soft keyboard, and the user hasn't
    // asked for it yet. They can tap the input themselves to start.
    if (window.innerWidth >= 1024) input.focus();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (m_pending) return;   // guardrail: don't queue sends while streaming
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      pushUser(text);
      rerender();
      await sendAndReply(text);
      rerender();
    });

    // Stop-button: aborts the in-flight stream. The sendAndReply handler
    // detects the aborted state, appends a "stopped" suffix, and releases
    // m_pending so the input re-enables.
    main.querySelector("#chat-stop")?.addEventListener("click", () => {
      if (m_abortController) m_abortController.abort();
    });

    main.querySelectorAll("[data-q]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (m_pending) return;
        const q = btn.dataset.q;
        input.value = q;
        form.dispatchEvent(new Event("submit"));
      });
    });

    main.querySelector("#chat-clear").addEventListener("click", () => {
      if (confirm("Clear THIS chat's history? Previous sessions in the 🗂 menu stay.")) {
        // Wipe only the active session's messages (not all sessions).
        clearActiveMessages(sessionsData);
        // Re-bind chatLog to the (now empty) same session's messages array.
        chatLog = getActiveSession(sessionsData).messages;
        rerender();
      }
    });

    // Session picker + new-chat + session switch / delete handlers.
    main.querySelector("#chat-new-btn")?.addEventListener("click", () => {
      // Abort any in-flight stream before swapping sessions so tokens from
      // the previous session don't leak into the new one.
      if (m_abortController) { try { m_abortController.abort(); } catch {} }
      m_abortController = null;
      m_pending = false;
      createNewSession(sessionsData);
      rebindActiveChatLog();
      render();
    });

    const pickerBtn = main.querySelector("#chat-session-picker");
    const pickerMenu = main.querySelector("#chat-session-menu");
    pickerBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !pickerMenu.hidden;
      if (open) {
        pickerMenu.hidden = true;
        pickerBtn.setAttribute("aria-expanded", "false");
        return;
      }
      // Build the menu lazily so timestamps are fresh every open.
      pickerMenu.innerHTML = sessionsData.sessions.map(s => {
        const isActive = s.id === sessionsData.activeId;
        const title = escapeHtml(s.title || "New chat");
        const rel = escapeHtml(formatRelative(s.updatedAt || s.createdAt));
        const count = (s.messages || []).length;
        return `
          <div class="chat-session-row ${isActive ? "active" : ""}" data-session-id="${escapeAttr(s.id)}" role="option" aria-selected="${isActive ? "true" : "false"}">
            <button type="button" class="chat-session-row-main" data-switch-session="${escapeAttr(s.id)}">
              <div class="chat-session-row-title">${title}</div>
              <div class="chat-session-row-meta">${count} msg${count === 1 ? "" : "s"} · ${rel}</div>
            </button>
            <button type="button" class="chat-session-row-del" data-delete-session="${escapeAttr(s.id)}" aria-label="Delete this chat" title="Delete this chat">×</button>
          </div>
        `;
      }).join("");
      pickerMenu.hidden = false;
      pickerBtn.setAttribute("aria-expanded", "true");
    });

    // Outside-click closes the picker. One listener added per render —
    // cleaned up on next render via innerHTML replacement (implicit).
    const closePicker = (e) => {
      if (!pickerMenu || pickerMenu.hidden) return;
      if (e.target.closest("#chat-session-picker") || e.target.closest("#chat-session-menu")) return;
      pickerMenu.hidden = true;
      pickerBtn?.setAttribute("aria-expanded", "false");
    };
    document.addEventListener("click", closePicker, { once: false });
    // We rely on document listeners getting cleaned up naturally when the
    // hash changes (chat page unmounts); no explicit removal needed for now.

    pickerMenu?.addEventListener("click", (e) => {
      const switchBtn = e.target.closest("[data-switch-session]");
      const delBtn = e.target.closest("[data-delete-session]");
      if (delBtn) {
        e.stopPropagation();
        const id = delBtn.dataset.deleteSession;
        const s = sessionsData.sessions.find(x => x.id === id);
        const label = s?.title || "this chat";
        if (!confirm(`Delete "${label}"? This can't be undone.`)) return;
        // If we're aborting the current session, cancel its stream.
        if (sessionsData.activeId === id && m_abortController) {
          try { m_abortController.abort(); } catch {}
          m_abortController = null;
          m_pending = false;
        }
        deleteSessionById(sessionsData, id);
        rebindActiveChatLog();
        pickerMenu.hidden = true;
        render();
        return;
      }
      if (switchBtn) {
        const id = switchBtn.dataset.switchSession;
        if (id === sessionsData.activeId) {
          pickerMenu.hidden = true;
          pickerBtn.setAttribute("aria-expanded", "false");
          return;
        }
        if (m_abortController) { try { m_abortController.abort(); } catch {} }
        m_abortController = null;
        m_pending = false;
        setActiveSession(sessionsData, id);
        rebindActiveChatLog();
        pickerMenu.hidden = true;
        render();
      }
    });
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
        <div style="margin: auto; text-align: center; color: var(--text-muted); max-width: 460px;">
          <div style="font-size: 40px; margin-bottom: var(--sp-3);">🎓</div>
          <div class="font-semi" style="color: var(--text-strong); margin-bottom: var(--sp-2);">Hi — I'm Saathi</div>
          <div class="text-sm">I talk about one thing: money. Ask about SIPs, crashes, valuation, taxes, or any finfluencer claim that felt off. I explain — I don't give tips. Ask me about cooking and I'll politely decline.</div>
        </div>
      `;
    }
    return chatLog.map(m => renderBubble(m)).join("") +
      (m_pending ? renderTyping() : "");
  }
}

let m_pending = false;
let m_abortController = null;

function renderBubble(m) {
  const streamAttr = m.streaming ? ` data-streaming="1"` : "";
  if (m.role === "user") {
    // Ultra-tight hug — ≈1.7px vertical, ≈3.9px horizontal at text-sm
    // (font unchanged). Line-height tight too so the bubble sits
    // millimetre-off the glyphs.
    return `
      <div${streamAttr} style="align-self: flex-end; width: fit-content; max-width: 78%; background: var(--brand); color: white; padding: 0.13em 0.3em; border-radius: 8px 8px 2px 8px; font-size: var(--text-sm); line-height: 1.3; white-space: pre-wrap; word-wrap: break-word; box-shadow: var(--sh-xs);">
        <span class="msg-body">${escapeHtml(m.text)}</span>
      </div>
    `;
  }
  return `
    <div${streamAttr} style="align-self: flex-start; width: fit-content; max-width: 82%; display: flex; gap: 5px; align-items: flex-start;">
      <div class="friend-avatar green" style="width: 18px; height: 18px; font-size: 8px; flex-shrink: 0;">SS</div>
      <div style="background: var(--surface); border: 1px solid var(--border); padding: 0.13em 0.3em; border-radius: 8px 8px 8px 2px; font-size: var(--text-sm); line-height: 1.3; white-space: pre-wrap; word-wrap: break-word; color: var(--text); box-shadow: var(--sh-xs);">
        <span class="msg-body">${renderMarkdown(m.text)}</span>
      </div>
    </div>
  `;
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
  return `
    <div style="align-self: flex-start; display: flex; gap: 10px; align-items: flex-start;">
      <div class="friend-avatar green" style="width: 28px; height: 28px; font-size: 11px; flex-shrink: 0;">SS</div>
      <div style="background: var(--surface); border: 1px solid var(--border); padding: 12px 16px; border-radius: 16px;">
        <div class="coach-typing" style="padding: 0;"><span></span><span></span><span></span></div>
      </div>
    </div>
  `;
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
  if (isOffTopic(userText)) {
    const ownerSession_ = getActiveSession(sessionsData);
    ownerSession_.messages.push({ role: "assistant", text: offTopicRedirect(userText), ts: Date.now() });
    saveSessions(sessionsData);
    if (sessionsData.activeId === ownerSession_.id) {
      chatLog = ownerSession_.messages;
      render();
    }
    m_pending = false;
    m_abortController = null;
    return;
  }

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
  if (shell) {
    shell.classList.add("is-busy");
    // Live typing dots INSIDE the composer. The old treatment just disabled
    // the input and set the placeholder to "Saathi is responding…", which
    // reads as a dead form rather than a busy one — especially when a reply
    // takes a few seconds.
    if (!shell.querySelector(".composer-dots")) {
      shell.insertAdjacentHTML("afterbegin",
        `<span class="composer-dots" aria-live="polite"><span>Saathi is thinking</span><i></i><i></i><i></i></span>`);
    }
  }
  if (input) {
    input.setAttribute("readonly", "readonly");
    input.placeholder = "";
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
      inputNow.placeholder = "Ask about SIPs, P/E, crashes, anything…";
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
  const messages = chatLog.slice(-12).map(m => ({
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
  const dossier = await buildDossier();

  const wantTools = needsLiveData(userText, chatLog.slice(-8, -1));

  if (wantTools) {
    // Tool-use path: non-streaming, standard runAgent with TOOLS.
    reRenderOuter();   // show typing indicator
    let replyText = null;
    let errorText = null;
    try {
      const system = `${SYSTEM_PROMPT}\n\n${runtimeFacts(marketStatus())}\n\n${dossier}\n\n# TOOL USE\nYou have tools for live data: get_stock_price, get_crypto_price, search_stocks, get_market_news, get_user_portfolio, get_trade_history, get_watchlist, get_limit_orders. USE them whenever the user asks about any specific stock, crypto, market state, or their portfolio. Never guess numbers — always call the tool.\n\nCRITICAL: Call tools via the STRUCTURED tool_calls API only. NEVER write literal text like 'CALL search_stocks(...)' or '[Tool call: ...]' or fenced ` + "```tool_calls```" + ` JSON in your visible response. Those are internal scaffolding the user must never see. If you want to call a tool, emit the tool_call JSON block and let the system handle it. Your visible reply either (a) answers the user's question with real data you just received from a tool, or (b) says you'll look it up — never describes the mechanics of looking it up.\n\n# TONE\nKeep replies conversational and short by default (1–3 sentences). Only go longer when the user asks for explanation or depth.`;
      replyText = await runAgent({
        apiKey: state.settings.llmApiKey || null,
        system,
        messages,
        profile: "fast",
      });
    } catch (e) {
      console.warn("coach chat tool path error:", e);
      errorText = "Couldn't reach Saathi right now. Try again in a moment.";
    }
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
    if (looksLikeLookupOffer(cleanedReply) || pricelessList) {
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
        const retryStillBad = looksLikeLookupOffer(cleanRetry)
          || looksLikePricelessList(cleanRetry, userText);
        if (cleanRetry && cleanRetry.trim() && !retryStillBad) cleanedReply = cleanRetry;
      } catch (e) { console.warn("[chat] lookup-offer retry failed:", e?.message || e); }
    }
    const finalText = (cleanedReply && cleanedReply.trim()) ? cleanedReply : (errorText || "Saathi couldn't answer that. Try rephrasing or asking again.");
    ownerMessages.push({ role: "assistant", text: finalText, ts: Date.now() });
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
        userText, assistantText: replyText, model: "gemini-chat",
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

  const system = `${SYSTEM_PROMPT}\n\n${NO_TOOLS_NOTE}\n\n${runtimeFacts(marketStatus())}\n\n${dossier}\n\n# TONE\nKeep replies conversational and short by default (1–3 sentences). Only go longer when the user asks for explanation or depth.`;
  let result = null;
  try {
    result = await streamChat({
      system,
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
    } else if (looksLikeLookupOffer(entry.text)) {
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
      if (cleanEsc && cleanEsc.trim()) entry.text = cleanEsc.trim();
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
    } else if (!entry.text.trim()) {
      entry.text = "Hmm, I went quiet there. Ask me once more?";
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
