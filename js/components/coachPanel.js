// =============================================================================
// COACH PANEL — Interactive chat. Right-docked on desktop, FAB + slide-over
// on mobile. Hidden entirely on public routes (landing/login/register) so it
// never overlays the signup CTAs on phones.
// =============================================================================

import { getState, subscribe, setSetting } from "../state.js";
import { getInstrument } from "../data/universe.js";
import { getNews } from "../data/news.js";
import { formatRupees, formatPct } from "../money.js";
import { SYSTEM_PROMPT, matchTemplate, isOffTopic, offTopicRedirect, STARTER_QUESTIONS, runtimeFacts, NO_TOOLS_NOTE } from "../coach/persona.js";
import { marketStatus } from "../data/prices.js";
import { runAgent, streamChat, needsLiveData, logChatTurn, isToolCallOnly, looksLikeLookupOffer } from "../coach/agent.js";

const CHAT_LOG_KEY = "ss.coachchat.v1";

let chatHistory = loadChat();
let pending = false;
let abortController = null;
let newsSnap = [];
let root;
let fab;

// Routes where the coach panel + FAB are completely hidden
const COACH_HIDDEN_ROUTES = new Set(["", "/", "/login", "/register"]);

function isCoachAllowed() {
  const state = getState();
  if (!state.isAuthed) return false;
  const hash = (location.hash.slice(1) || "/").split("?")[0];
  if (COACH_HIDDEN_ROUTES.has(hash)) return false;
  return true;
}

// Streaming path only — no tools are wired there, so say so.
const SAATHI_NO_TOOLS = `${SYSTEM_PROMPT}\n\n${NO_TOOLS_NOTE}`;

const SAATHI_SYSTEM = `${SYSTEM_PROMPT}\n\n# TOOL USE\nYou have tools for live data: get_stock_price, get_crypto_price, search_stocks, get_market_news, get_user_portfolio, get_trade_history. USE them whenever the user asks about any specific stock, crypto, market state, or their portfolio. Never guess numbers — always call the tool.`;

function loadChat() {
  try { const raw = localStorage.getItem(CHAT_LOG_KEY); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}

// Same-tab hydrate trigger from Supabase: when sync.js's hydrateCoachChats
// writes fresh coach_log into localStorage (e.g. first login on incognito
// / a new device), it dispatches 'ss:coach-sync'. We reload our in-memory
// chatHistory and re-render the panel so the user sees their history.
// Skip the reload mid-stream so we don't clobber a token-in-flight bubble.
window.addEventListener("ss:coach-sync", () => {
  if (pending) return;
  try {
    chatHistory = loadChat();
    if (root) render();
  } catch (e) { console.warn("[coach-panel] ss:coach-sync failed:", e); }
});
function saveChat() {
  // Cap to the last 80 messages. On QuotaExceededError, progressively halve
  // until the write succeeds — losing old chat history is better than
  // silently failing to persist new messages.
  let keep = 80;
  while (keep >= 10) {
    try {
      localStorage.setItem(CHAT_LOG_KEY, JSON.stringify(chatHistory.slice(-keep)));
      return;
    } catch (e) {
      const isQuota = e && (e.name === "QuotaExceededError"
                            || (e.code && (e.code === 22 || e.code === 1014)));
      if (!isQuota) return;
      keep = Math.floor(keep / 2);
    }
  }
  // Last resort: drop everything (cache wipe; DB still has the turns).
  try { localStorage.removeItem(CHAT_LOG_KEY); } catch {}
  // v142: DB write happens per-turn via logChatTurn in the form submit
  // handler — no push from here. localStorage is now just the panel's
  // instant-paint cache, not the source of truth.
}

function smartTemplateReply(userText, state) {
  return matchTemplate(userText, {
    holdings: state.holdings || {},
    newsItems: newsSnap,
    symbolOf: getInstrument,
  });
}

function summarisePortfolio(state) {
  if (!state?.holdings) return "Not logged in.";
  const syms = Object.keys(state.holdings);
  if (!syms.length) return `Cash: ${formatRupees(state.portfolio.cashPaise, { compact: true })}. No holdings yet.`;
  const lines = syms.slice(0, 8).map(s => {
    const h = state.holdings[s];
    return `${s} × ${h.qty} @ avg ₹${(h.avgCostPaise / 100).toFixed(2)}`;
  });
  // Label this explicitly. A live probe had the model read this block and
  // answer "Your total portfolio is worth ₹38,100.00 ... you're down ₹4,000"
  // — arithmetic invented out of average costs, with no live price anywhere
  // in sight. Average cost is what was PAID; current value needs a quote.
  return `Cash: ${formatRupees(state.portfolio.cashPaise, { compact: true })}\n`
    + `Holdings (${syms.length}), shown as quantity @ AVERAGE BUY PRICE (what they paid — NOT current value): ${lines.join(", ")}\n`
    + `No live prices in this block. Do not compute a total, a profit, or a return % from it.`;
}

async function callLlmAgent(apiKey, history, state) {
  // No client-side off-topic pre-filter. Let the LLM decide how to handle
  // off-topic questions per the system prompt — previously we'd intercept
  // "hello" and return a canned redirect before the model ever saw it,
  // which made the coach feel like a decision tree instead of a coach.
  const portfolioSummary = summarisePortfolio(state);
  const newsContext = newsSnap.slice(0, 5).map(n => `- ${n.headline} (${n.source}) [${n.sentiment}]`).join("\n");
  const system = `${SAATHI_SYSTEM}\n\n${runtimeFacts(marketStatus())}\n\n# RUNTIME CONTEXT\n## User portfolio\n${portfolioSummary}\n\n## Latest market headlines\n${newsContext || "(none loaded)"}\n\n# TONE\nKeep replies short by default (1–3 sentences). Go longer only when asked for depth.`;

  const messages = history.slice(-12).map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.text,
  }));
  // Tool-use path: "fast" profile (Gemini 3 Flash Preview) is more reliable
  // at function calling than Lite. Lite is kept for pure conversational chat
  // only; when the query needs live data, pay the small latency hit for a
  // model that actually calls the tool every time.
  return await runAgent({ apiKey, system, messages, profile: "fast" });
}

// -----------------------------------------------------------------------------
export function mountCoachPanel() {
  root = document.getElementById("coach-root");
  if (!root) return;

  // Mobile / tablet (< 1280 px) treats the coach panel as a transient
  // drawer opened by the FAB — never a persistent overlay. But the
  // coachPanelOpen setting is localStorage-persisted for desktop's "dock"
  // behaviour, so if the user enabled it on desktop (or toggled it from
  // Settings by accident on mobile) and then visits on a phone, the
  // panel would auto-open as a full-viewport overlay they can't dismiss
  // without finding the tiny ✕ in the header. Reset the flag on mount
  // below the docking breakpoint so the panel starts closed on mobile
  // every session regardless of persisted state. FAB tap still sets it
  // true for the rest of the session.
  if (window.innerWidth < 1280 && getState().settings.coachPanelOpen) {
    setSetting("coachPanelOpen", false);
  }

  // Pre-fetch news (best-effort) for chat context
  getNews({ limit: 12 }).then(items => { newsSnap = items || []; render(); }).catch(() => {});

  render();
  subscribe(render);
  window.addEventListener("hashchange", render);

  // FAB — only present when the coach is allowed on this route
  fab = document.createElement("button");
  fab.className = "coach-fab";
  fab.setAttribute("aria-label", "Open coach");
  fab.innerHTML = `<span>💬</span>`;
  fab.addEventListener("click", () => {
    setSetting("coachPanelOpen", !getState().settings.coachPanelOpen);
  });
  document.body.appendChild(fab);

  let wasOpenLastTick = false;
  const applyVisibility = () => {
    const allowed = isCoachAllowed();
    const state = getState();
    fab.style.display = allowed ? "" : "none";
    if (!allowed) {
      document.body.classList.remove("coach-docked");
      root.classList.remove("open");
      root.style.display = "none";
      wasOpenLastTick = false;
      return;
    }
    root.style.display = "";
    const shouldDock = window.innerWidth >= 1280 && state.settings.coachPanelOpen;
    const shouldOpen = !shouldDock && state.settings.coachPanelOpen;
    if (shouldDock) {
      document.body.classList.add("coach-docked");
    } else {
      document.body.classList.remove("coach-docked");
      root.classList.toggle("open", shouldOpen);
    }
    // Focus the chat input ONLY on the closed → open transition, not on
    // every applyVisibility tick (which fires on every state change and
    // every route navigation). Previously render() called input.focus()
    // unconditionally, which popped the mobile keyboard every time the
    // user tapped a nav tab — even when the coach panel wasn't visible.
    const isOpenNow = shouldDock || shouldOpen;
    if (isOpenNow && !wasOpenLastTick) {
      root.querySelector("#coach-input")?.focus();
    }
    wasOpenLastTick = isOpenNow;
  };
  applyVisibility();
  window.addEventListener("resize", applyVisibility);
  window.addEventListener("hashchange", applyVisibility);
  subscribe(applyVisibility);
}

function render() {
  if (!root) return;
  const state = getState();
  const messages = renderMessagesHtml(state);
  const usingLLM = !!state.settings.llmApiKey;

  root.innerHTML = `
    <div class="coach-header">
      <div class="coach-header-title">
        <div class="coach-avatar-sm">SS</div>
        <div>
          <div style="font-size: var(--text-md);">Saathi</div>
          <div class="dim" style="font-size: 11px; font-weight: 400;">${usingLLM ? "Your key · finance only" : "Server LLM · finance only"}</div>
        </div>
      </div>
      <button class="btn btn-ghost btn-icon" id="coach-close-btn" aria-label="Close coach">✕</button>
    </div>

    <div class="coach-messages" id="coach-messages-scroll">
      ${messages}
    </div>

    <form class="composer" id="coach-form" autocomplete="off">
      <div class="composer-shell ${pending ? "is-busy" : ""}">
        ${pending
          ? `<span class="composer-dots" aria-live="polite"><span>Thinking</span><i></i><i></i><i></i></span>`
          : ""}
        <input id="coach-input" class="composer-input"
               placeholder="${pending ? "" : "Ask about any stock, crypto, or concept…"}"
               maxlength="300" aria-label="Message Saathi" ${pending ? "disabled" : ""} />
        ${pending
          ? `<button type="button" class="composer-btn is-stop" id="coach-stop" title="Stop generating" aria-label="Stop generating">&#9632;</button>`
          : `<button type="submit" class="composer-btn" id="coach-send" title="Send" aria-label="Send message">&#8593;</button>`}
      </div>
    </form>

    <div class="coach-footer">
      Grounded in live prices + your portfolio + real news
    </div>
  `;

  const ms = root.querySelector("#coach-messages-scroll");
  if (ms) ms.scrollTop = ms.scrollHeight;

  root.querySelector("#coach-close-btn")?.addEventListener("click", () => {
    setSetting("coachPanelOpen", false);
  });

  // Stop button aborts in-flight streaming. Whatever streamed so far stays
  // in the chat history; pending flips off and the Send button returns.
  root.querySelector("#coach-stop")?.addEventListener("click", () => {
    if (abortController) abortController.abort();
  });

  const form = root.querySelector("#coach-form");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const input = root.querySelector("#coach-input");
    const text = input.value.trim();
    if (!text || pending) return;
    input.value = "";
    chatHistory.push({ role: "user", text, ts: Date.now() });
    saveChat();
    pending = true;
    render();

    const s = getState();

    // Streaming path for conversational messages — push placeholder bubble
    // and append tokens as they arrive. For messages that need live data
    // (stock prices, portfolio, news) we fall through to the non-streaming
    // tool-use path below.
    // chatHistory already has this turn's user message pushed, so hand the
    // heuristic the turns BEFORE it as context for short follow-ups.
    if (!needsLiveData(text, chatHistory.slice(-9, -1))) {
      abortController = new AbortController();
      const placeholderIdx = chatHistory.length;
      chatHistory.push({ role: "assistant", text: "", ts: Date.now(), streaming: true });
      render();
      const portfolioSummary = summarisePortfolio(s);
      const newsContext = newsSnap.slice(0, 5).map(n => `- ${n.headline} (${n.source}) [${n.sentiment}]`).join("\n");
      const system = `${SAATHI_NO_TOOLS}\n\n${runtimeFacts(marketStatus())}\n\n# RUNTIME CONTEXT\n## User portfolio\n${portfolioSummary}\n\n## Latest market headlines\n${newsContext || "(none loaded)"}\n\n# TONE\nKeep replies short by default (1–3 sentences). Go longer only when asked for depth.`;
      const messages = chatHistory.slice(-12).filter(m => !m.streaming || m === chatHistory[placeholderIdx]).slice(0, -1).map(m => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text,
      }));
      let result = null;
      let rafPending = false;
      try {
        result = await streamChat({
          system,
          messages,
          profile: "chat",
          signal: abortController.signal,
          onToken: (delta) => {
            if (!chatHistory[placeholderIdx]) return;
            chatHistory[placeholderIdx].text += delta;
            // Coalesce token updates to 60fps max — gemini streams faster
            // than the main thread can rebuild the messages list on phones.
            if (!rafPending) {
              rafPending = true;
              requestAnimationFrame(() => {
                rafPending = false;
                const ms = root?.querySelector("#coach-messages-scroll");
                if (ms) {
                  ms.innerHTML = renderMessagesHtml(getState());
                  ms.scrollTop = ms.scrollHeight;
                }
              });
            }
          },
        });
      } catch (e) { console.warn("coach stream error:", e); }
      const entry = chatHistory[placeholderIdx];
      if (entry) {
        entry.streaming = false;
        // Reconcile against the fully-cleaned text. Tokens are painted as
        // they arrive, so a tool-call leak or a reasoning preamble can be
        // on screen before enough of it exists to recognise and strip. The
        // stream's final text has been through the full stripper, so adopt
        // it — a brief flash is fine, a persisted leak is not.
        if (!result?.aborted && result?.text && result.text.trim() && result.text !== entry.text) {
          entry.text = result.text;
        }
        if (result?.aborted) {
          const suffix = "\n\n— ok, I'll stop there. Ping me again if you want more.";
          entry.text = entry.text.trim()
            ? entry.text.trim() + suffix
            : "No worries — ask again when you're ready.";
        } else if (result?.error && !entry.text.trim()) {
          entry.text = "Hmm, I can't reach my brain right now. Give it a sec and try again?";
        } else if (looksLikeLookupOffer(entry.text)) {
          // No tools on the streaming path, so an offer to fetch is a dead
          // end. The user already asked — go get it.
          const retry = await callLlmAgent(s.settings.llmApiKey || null, chatHistory, s).catch(() => null);
          if (retry && retry.trim()) entry.text = retry.trim();
        } else if (!entry.text.trim() && isToolCallOnly(result?.raw)) {
          // The model answered with nothing but a tool call — it decided it
          // needed live data on the path that has no tools wired. It was
          // right; it was just on the wrong path. Re-run the turn through
          // runAgent, which has the real tools, instead of apologising.
          const retry = await callLlmAgent(s.settings.llmApiKey || null, chatHistory, s).catch(() => null);
          entry.text = (retry && retry.trim())
            ? retry
            : "Let me pull that up — ask me once more?";
        } else if (!entry.text.trim()) {
          entry.text = result?.text && result.text.trim()
            ? result.text
            : "Hmm, I went quiet there. Ask me once more?";
        }
      }
      saveChat();
      pending = false;
      abortController = null;
      // Log the finished turn to coach_messages so admin panel can see it
      // AND so rebuildChatSessionsFromDb reconstructs the side-panel log
      // on boot / after login-on-other-device.
      if (!result?.aborted && !result?.error && entry && entry.text && !entry.text.startsWith("Hmm")) {
        logChatTurn({
          userText: text, assistantText: entry.text, model: "gemini-chat",
          surface: "side_panel",
        });
      }
      render();
      return;
    }

    // Tool-use path (live data queries): non-streaming.
    let reply = null;
    try {
      reply = await callLlmAgent(s.settings.llmApiKey || null, chatHistory, s);
    } catch (e) { console.warn("coach panel error:", e); }
    // If it offered to look something up instead of doing it, push once more.
    if (reply && looksLikeLookupOffer(reply)) {
      try {
        const again = await callLlmAgent(s.settings.llmApiKey || null, chatHistory, s);
        if (again && again.trim() && !looksLikeLookupOffer(again)) reply = again;
      } catch (e) { console.warn("coach panel lookup-offer retry:", e); }
    }
    if (!reply || !reply.trim()) {
      reply = "Hmm, I can't reach my brain right now. Give it a sec and try again?";
    } else {
      // Successful tool-use turn — log to DB for admin review.
      logChatTurn({ userText: text, assistantText: reply, model: "gemini-chat-tools" });
    }

    chatHistory.push({ role: "assistant", text: reply, ts: Date.now() });
    saveChat();
    pending = false;
    render();
  });

  // Intentionally NOT calling input.focus() here — render() runs on every
  // state change and every hashchange, so focusing would pop the mobile
  // virtual keyboard every time the user tapped any nav tab (even when
  // the coach panel itself is closed and off-screen). applyVisibility()
  // now does a single focus on the closed → open transition instead.
}

function renderMessagesHtml(state) {
  const trade = (state.coachMessages || []).slice(-5).map(m => ({
    role: "assistant", text: m.payload?.reflection || "",
    context: m.payload?.historical_context, question: m.payload?.suggested_q,
    warning: m.payload?.warning_level, citations: m.payload?.citations || [],
    symbol: m.triggerSymbol, ts: m.ts, isTrade: true,
  })).filter(m => m.text);

  const chat = chatHistory.slice(-20).map(m => ({ ...m, isTrade: false }));
  const all = [...trade, ...chat].sort((a, b) => a.ts - b.ts).slice(-25);

  if (!all.length && !pending) {
    return `
      <div class="coach-empty">
        <span class="emoji">🎓</span>
        <div class="font-semi" style="color: var(--text-strong); font-size: var(--text-md);">Hi — I'm Saathi</div>
        <div class="text-sm">I talk about one thing: money. Ask me any stock or crypto price, any concept, or a trade you're thinking about. I explain — I don't give tips.</div>
        <div class="flex-col gap-2" style="margin-top: var(--sp-3); width: 100%;">
          ${STARTER_QUESTIONS.slice(0, 4).map(q =>
            `<button type="button" class="filter-pill" data-suggest="${escapeAttr(q)}" style="text-align: left; font-size: 11px;">💬 ${escapeHtml(q)}</button>`
          ).join("")}
        </div>
      </div>
    `;
  }

  setTimeout(() => {
    root?.querySelectorAll("[data-suggest]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        const input = root.querySelector("#coach-input");
        if (input) { input.value = btn.dataset.suggest; input.focus(); }
      });
    });
  }, 0);

  return all.map(m => {
    if (m.role === "user") {
      return `<div class="coach-user-msg">${escapeHtml(m.text)}</div>`;
    }
    if (m.isTrade) {
      const lvl = m.warning === "strong_caution" ? "strong-caution" : m.warning === "caution" ? "caution" : "";
      return `
        <div class="coach-message">
          <div class="coach-bubble ${lvl}">
            <div class="coach-bubble-head">
              <span>${timeAgo(m.ts)}</span>
              ${m.symbol ? `<span class="pill pill-neutral" style="font-size: 10px;">${m.symbol}</span>` : ""}
            </div>
            <div>${escapeHtml(m.text)}</div>
            ${m.context ? `<div class="coach-context">${escapeHtml(m.context)}</div>` : ""}
            ${m.question ? `<div class="coach-question">${escapeHtml(m.question)}</div>` : ""}
          </div>
        </div>
      `;
    }
    return `
      <div class="coach-message">
        <div class="coach-bubble">
          <div class="coach-bubble-head"><span>${timeAgo(m.ts)}</span></div>
          <div style="white-space: pre-wrap; word-wrap: break-word;">${renderMarkdown(m.text)}</div>
        </div>
      </div>
    `;
  }).join("") + (pending ? `
    <div class="coach-message">
      <div class="coach-bubble">
        <div class="coach-typing"><span></span><span></span><span></span></div>
      </div>
    </div>
  ` : "");
}

function timeAgo(ts) {
  const m = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

// Minimal safe Markdown renderer — escapes HTML first, then converts
// **bold**, *italic*, `code`, and bare URLs. Keeps Gemini's natural
// Markdown output readable instead of rendering literal asterisks.
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
