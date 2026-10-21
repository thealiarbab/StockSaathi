// =============================================================================
// COACH PANEL — Interactive chat. Right-docked on desktop, slide-over on
// mobile. Its lightweight launcher lives in coachLauncher.js.
// =============================================================================

import { getState, subscribe, setSetting } from "../state.js";
import { nextTs, byTurn, repairTurnOrder } from "../features/chatOrder.js";
import { isPreview } from "../features/preview.js";
import { isCommand, runCommand, cardHtml, hydrateCards, guideHtml, CHART_TOOL_NOTE, hideChartMarkers, extractChartMarker } from "../features/chatCards.js";
import { sendFeedback } from "../features/chatCloud.js";
import { getInstrument } from "../data/universe.js";
import { getNews } from "../data/news.js";
import { formatRupees, formatPct } from "../money.js";
import { SYSTEM_PROMPT, matchTemplate, isOffTopic, offTopicRedirect, STARTER_QUESTIONS, runtimeFacts, NO_TOOLS_NOTE } from "../coach/persona.js";
import { marketStatus } from "../data/prices.js";
import { runAgent, streamChat, needsLiveData, logChatTurn, isToolCallOnly, looksLikeLookupOffer, looksLikeFetchPromise, looksLikePricelessList, scrubAdvice, looksHinglish, hasFormalHindiRegister, isNewsQuestion, prefetchNewsBlock, unsourcedFigures, figureSources, dropFigureSentences } from "../coach/agent.js";
import { getFreshCachedQuote } from "../data/marketData.js";
import { buildDossier } from "../coach/dossier.js";
import { normalizeLookupProvenance, withLookupProvenance } from "../coach/lookupProvenance.js";

const CHAT_LOG_KEY = "ss.coachchat.v1";
// Turns taken off the panel by edit / regenerate. Without these, the merge in
// saveChat (another tab's copy) and the boot rebuild from coach_messages
// would bring them straight back.
const PRUNED_KEY = "ss.coachchat.pruned.v1";
const turnKey = (m) => `${m?.role}:${m?.ts}`;
function readPruned() {
  try { return new Set(JSON.parse(localStorage.getItem(PRUNED_KEY) || "[]")); } catch { return new Set(); }
}
function addPruned(msgs) {
  const set = readPruned();
  for (const m of msgs) set.add(turnKey(m));
  try { localStorage.setItem(PRUNED_KEY, JSON.stringify([...set].slice(-300))); } catch {}
}

let chatHistory = loadChat();
let pending = false;
let abortController = null;
let newsSnap = [];
let root;

// Routes where the coach panel is completely hidden
const COACH_HIDDEN_ROUTES = new Set(["", "/", "/login", "/register"]);

function isCoachAllowed() {
  const state = getState();
  if (!state.isAuthed) return false;
  const path = location.pathname || "/";
  if (COACH_HIDDEN_ROUTES.has(path)) return false;
  return true;
}

// Streaming path only — no tools are wired there, so say so.
const SAATHI_NO_TOOLS = `${SYSTEM_PROMPT}\n\n${NO_TOOLS_NOTE}`;

const SAATHI_SYSTEM = `${SYSTEM_PROMPT}\n\n# TOOL USE\nYou have tools for live data: get_stock_price, get_crypto_price, search_stocks, get_market_news, get_user_portfolio, get_trade_history, get_watchlist, get_limit_orders, get_fundamentals. USE them whenever the user asks about any specific stock, crypto, market state, company fundamentals (profit, EPS, ROE, P/E, debt, market cap), or their portfolio. Never guess numbers — always call the tool.`;

function loadChat() {
  try {
    const raw = localStorage.getItem(CHAT_LOG_KEY);
    const pruned = readPruned();
    const log = (raw ? JSON.parse(raw) : []);
    if (!Array.isArray(log)) return [];
    const kept = pruned.size ? log.filter((m) => !pruned.has(turnKey(m))) : log;
    repairTurnOrder(kept);
    return kept;
  }
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
  // Merge what another tab stored first (C17): the tab that saved last used
  // to erase the other's turns. Same match as /chat: role + timestamp.
  try {
    const stored = loadChat();
    if (Array.isArray(stored) && stored.length) {
      const have = new Set(chatHistory.map((m) => `${m?.role}:${m?.ts}`));
      let added = false;
      for (const m of stored) {
        if (m && !have.has(`${m.role}:${m.ts}`)) { chatHistory.push(m); added = true; }
      }
      if (added) { chatHistory.sort(byTurn); repairTurnOrder(chatHistory); }
    }
  } catch {}
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

// summarisePortfolio was removed 2026-09-14. It rendered the user's holdings
// as "SYM x QTY @ avg RsN" - cost basis only, no market value - and
// COACH_FIXES §3 records the model multiplying that roster and presenting
// the product as a portfolio valuation ("worth Rs 38,100.00... down
// Rs 4,000.00", every number invented).
//
// js/coach/dossier.js replaces it and states market value directly, so the
// model has no arithmetic to do. Do not reintroduce a second portfolio
// block alongside it: two of them in one prompt is how §3 happened.

// C24: the panel opens on top of a page, and users ask about that page
// ("This company's profit this year" on /stocks/HDFCBANK got "Which company
// are you looking at?"). Tell the model what is on screen.
function currentScreen() {
  const path = location.pathname || "/";
  const m = path.match(/^\/stocks\/([^/]+)\/?$/);
  if (m) {
    const sym = decodeURIComponent(m[1]);
    const inst = getInstrument(sym);
    if (!inst) return "";
    const q = getFreshCachedQuote(inst.symbol, 10 * 60_000);
    const px = q?.pricePaise ? `, last price ${formatRupees(q.pricePaise)}` : "";
    const kind = inst.kind === "MF" ? "mutual fund" : inst.kind === "ETF" ? "ETF" : "stock";
    return `## Current screen\nThe user is on the ${kind} page for ${inst.name || inst.symbol} (${inst.symbol})${px}. "This company", "this stock", "isme", "iska" and similar mean ${inst.symbol}.`;
  }
  if (path === "/portfolio") return "## Current screen\nThe user is looking at their own portfolio page.";
  const r = path.match(/^\/crash-replay\/([^/]+)/);
  if (r) return `## Current screen\nThe user is watching the crash replay "${decodeURIComponent(r[1])}".`;
  return "";
}

// "This company…" / "isme…" on a stock page is a question about that stock:
// it needs the tool path even without a data word in it.
const DEICTIC_RE = /\b(?:this|isme|iska|iski|iske|ye|yeh)\b/i;
function onInstrumentPage() { return /^\/stocks\/[^/]+\/?$/.test(location.pathname || ""); }

// The Hinglish switch (header, /chat, Settings) is the only thing that picks
// the language. runtimeFacts() states it; this repeats it last in the prompt,
// where it holds better (C28). No guessing from the user's words.
function hinglishOn() {
  try { return !!getState().settings.hinglish; } catch { return false; }
}
function turnLanguage() {
  return hinglishOn()
    ? "\n\n# THIS TURN: LANGUAGE\nHinglish mode is on. Reply in casual Hinglish: mix everyday Roman Hindi with natural English words and phrases. Keep finance terms like P/E, SIP, NAV, price, profit, company and stock in English. Avoid formal Hindi translations such as 'tulna', 'ummeed', 'nirnay', 'nivesh', 'laabh', 'saalana', 'keemat' and 'moolya'."
    : "\n\n# THIS TURN: LANGUAGE\nReply in English.";
}

const FIGURE_RETRY_NOTE = `

# THIS TURN
Your earlier draft stated prices, moves or events that were not looked up. Call the tool for every figure you give (get_stock_price for a price or today's move, get_market_news for news), or leave the figure out.`;

const LANG_RETRY_NOTE = "\n\n# THIS TURN\nYour last draft did not follow the requested Hinglish style. Rewrite it in casual Hinglish: mix everyday Roman Hindi with natural English words, keep finance terms in English, and avoid formal Hindi such as 'tulna', 'ummeed', 'nirnay', 'nivesh', 'laabh', 'saalana', 'keemat' and 'moolya'.";

// Same last step as /chat: one bounded language retry, then remove any
// sentence that picks, praises/judges, nudges or times the market.
async function finishPanelReply(text, userText, retryAgent) {
  let out = text;
  const hi = hinglishOn();
  if (hi && (!looksHinglish(out) || hasFormalHindiRegister(out)) && retryAgent) {
    try {
      const again = await Promise.race([retryAgent(), new Promise((r) => setTimeout(() => r(null), 12_000))]);
      if (again && again.trim() && looksHinglish(again) && !hasFormalHindiRegister(again)) out = again.trim();
    } catch (e) { console.warn("[coach] language retry failed:", e?.message || e); }
  }
  return scrubAdvice(out, userText, hi).text;
}

async function callLlmAgent(apiKey, history, state, extraSystem = "", onText = null, onStep = null, lookupProvenance = null) {
  // No client-side off-topic pre-filter. Let the LLM decide how to handle
  // off-topic questions per the system prompt.
  const dossier = await buildDossier();
  const screen = currentScreen();
  const lastUser = [...history].reverse().find((m) => m.role === "user")?.text || "";
  // News-shaped question: fresh headlines fetched by the app (C5).
  const newsBlock = isNewsQuestion(lastUser) ? await prefetchNewsBlock(lastUser) : "";
  const system = `${SAATHI_SYSTEM}\n\n${runtimeFacts(marketStatus())}\n\n${dossier}\n\n# RUNTIME CONTEXT\n${screen ? screen + "\n" : ""}\n\n# TONE\nKeep replies short by default (1–3 sentences). Go longer only when asked for depth.` + newsBlock + (isPreview() ? CHART_TOOL_NOTE : "") + turnLanguage() + extraSystem;

  // Preserve full conversation history up to platform limits
  const messages = history.map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: withLookupProvenance(m.text, m.lookupProvenance),
  }));
  // Tool-use path: "fast" profile (Gemini 3 Flash Preview) is more reliable
  // at function calling than Lite.
  return await runAgent({
    apiKey, system, messages, profile: "fast", onText,
    onStep: (step) => {
      if (step?.action === "tool_results" && Array.isArray(lookupProvenance)) {
        lookupProvenance.push(...normalizeLookupProvenance(step.lookups));
      }
      onStep?.(step);
    },
  });
}

// -----------------------------------------------------------------------------
export function mountCoachPanel() {
  root = document.getElementById("coach-root");
  if (!root) return;

  // Pre-fetch news (best-effort) for chat context
  getNews({ limit: 12 }).then(items => { newsSnap = items || []; render(); }).catch(() => {});

  render();
  subscribe(render);
  window.addEventListener("ss:navigate", render);

  let wasOpenLastTick = false;
  let wasDrawerLastTick = false;
  // On phones and tablets the coach is a full-height drawer. Users couldn't
  // find their way out of it (rajveer 11 Oct, ayaan_lt 13 Oct: "chat hat hi
  // nahi rahi"): the only exit was a small ✕. Now the phone's Back button,
  // Esc and a swipe to the right also close it. Opening pushes a history
  // entry carrying ssCoach; Back pops it (navigation.js skips re-rendering
  // a same-URL pop) and the popstate listener below closes the drawer.
  const closeDrawer = () => setSetting("coachPanelOpen", false);
  let closingByNav = false;
  window.addEventListener("popstate", () => {
    if (!history.state?.ssCoach && wasDrawerLastTick) closeDrawer();
  });
  window.addEventListener("ss:navigate", () => {
    // A link inside the drawer moved the page underneath it: show the page.
    if (wasDrawerLastTick && window.innerWidth < 768) { closingByNav = true; closeDrawer(); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && wasDrawerLastTick && !document.querySelector(".modal-overlay")) closeDrawer();
  });
  let touchX = null, touchY = null;
  root.addEventListener("touchstart", (e) => {
    const t = e.touches[0]; touchX = t.clientX; touchY = t.clientY;
  }, { passive: true });
  root.addEventListener("touchend", (e) => {
    if (touchX == null || !wasDrawerLastTick) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchX, dy = Math.abs(t.clientY - touchY);
    touchX = touchY = null;
    if (dx > 80 && dy < 60) closeDrawer();
  }, { passive: true });

  const applyVisibility = () => {
    const allowed = isCoachAllowed();
    const state = getState();
    if (!allowed) {
      document.body.classList.remove("coach-docked");
      root.classList.remove("open");
      root.style.display = "none";
      document.body.classList.remove("coach-drawer-open");
      wasOpenLastTick = false;
      wasDrawerLastTick = false;
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

    const drawerNow = shouldOpen;   // open and not docked
    if (drawerNow && !wasDrawerLastTick) {
      if (!history.state?.ssCoach) history.pushState({ ...(history.state || {}), ssCoach: 1 }, "", location.href);
      document.body.classList.add("coach-drawer-open");
    } else if (!drawerNow && wasDrawerLastTick) {
      document.body.classList.remove("coach-drawer-open");
      // Closed by ✕ / Esc / swipe: drop the entry we pushed, so Back then
      // leaves the page as usual. Not after a navigation: that would undo it.
      if (history.state?.ssCoach && !closingByNav) history.back();
      closingByNav = false;
    }
    wasDrawerLastTick = drawerNow;
  };
  applyVisibility();
  window.addEventListener("resize", applyVisibility);
  window.addEventListener("ss:navigate", applyVisibility);
  subscribe(applyVisibility);
}

// U13: render() is subscribed to every state change (quote ticks
// included) and rebuilt the whole chat, Markdown and all, on every page
// while the panel sat closed: ~530 ms of a throttled /stocks load. Closed,
// it only notes that it is stale; the change that opens it renders it.
let _staleWhileClosed = false;

function render() {
  if (!root) return;
  const state = getState();
  if (!state.settings.coachPanelOpen && !pending) { _staleWhileClosed = true; return; }
  _staleWhileClosed = false;
  const messages = renderMessagesHtml(state);
  const usingLLM = !!state.settings.llmApiKey;

  // Same look as /chat (cc-* classes): avatar rows, your messages in a tinted
  // bubble, Saathi's as plain text, one rounded composer that grows.
  root.innerHTML = `
    <div class="coach-header">
      <div class="coach-header-title">
        <span class="cc-avatar" aria-hidden="true">S</span>
        <div style="min-width: 0;">
          <div class="coach-header-name">Saathi</div>
          <div class="coach-header-sub">${usingLLM ? "Your key · finance only" : "Your money coach"}</div>
        </div>
      </div>
      <div class="coach-header-actions">
        <button type="button" class="cc-chip-btn coach-lang ${state.settings.hinglish ? "is-on" : ""}" id="coach-lang-btn"
                aria-label="Switch reply language to ${state.settings.hinglish ? "English" : "Hinglish (Hindi in Roman script)"}"
                aria-pressed="${state.settings.hinglish ? "true" : "false"}">${state.settings.hinglish ? "Switch to English" : "Switch to Hinglish"}</button>
        <a href="/chat" class="cc-chip-btn coach-full" title="Open the full chat page" aria-label="Open full chat">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
        </a>
        <button class="cc-chip-btn coach-close" id="coach-close-btn" type="button" aria-label="Close coach"><span aria-hidden="true">✕</span><span class="coach-close-label">Close</span></button>
      </div>
    </div>

    <div class="coach-messages cc-messages" id="coach-messages-scroll">
      ${messages}
    </div>

    <form class="composer cc-composer coach-composer" id="coach-form" autocomplete="off">
      <div class="composer-shell ${pending ? "is-busy" : ""}">
        <textarea id="coach-input" class="composer-input" rows="1"
               placeholder="${pending ? "Saathi is replying…" : isPreview() ? "Ask anything, or type / for tools" : "Ask Saathi anything"}"
               maxlength="300" aria-label="Message Saathi" ${pending ? "disabled" : ""}></textarea>
        ${pending
          ? `<button type="button" class="composer-btn is-stop" id="coach-stop" title="Stop generating" aria-label="Stop generating">&#9632;</button>`
          : `<button type="submit" class="composer-btn" id="coach-send" title="Send" aria-label="Send message">&#8593;</button>`}
      </div>
      <p class="coach-foot">Saathi can make mistakes. Practice only, not investment advice.</p>
    </form>
  `;

  const coachInput = root.querySelector("#coach-input");
  if (coachInput) {
    const fit = () => { coachInput.style.height = "auto"; coachInput.style.height = Math.min(coachInput.scrollHeight, 140) + "px"; coachInput.style.overflowY = coachInput.scrollHeight > 140 ? "auto" : "hidden"; };
    coachInput.addEventListener("input", fit);
    coachInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!pending) root.querySelector("#coach-form")?.requestSubmit();
      }
    });
  }

  const ms = root.querySelector("#coach-messages-scroll");
  if (ms) {
    // Follow new text only while the reader is at the end (same rule as /chat).
    if (panelFollow) ms.scrollTop = ms.scrollHeight; else ms.scrollTop = panelScroll;
    ms.addEventListener("scroll", () => {
      panelScroll = ms.scrollTop;
      panelFollow = ms.scrollHeight - ms.scrollTop - ms.clientHeight < 80;
    }, { passive: true });
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(() => { if (panelFollow) ms.scrollTop = ms.scrollHeight; });
      ms.querySelectorAll(".ss-card").forEach((c) => ro.observe(c));
    }
    if (isPreview()) wirePanelExtras(ms, coachInput);
  }
  root.querySelectorAll("[data-suggest]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (pending || !coachInput) return;
      coachInput.value = btn.dataset.suggest;
      root.querySelector("#coach-form")?.requestSubmit();
    });
  });

  root.querySelector("#coach-lang-btn")?.addEventListener("click", () => {
    setSetting("hinglish", !getState().settings.hinglish);
  });

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
    chatHistory.push({ role: "user", text, ts: nextTs(chatHistory) });
    saveChat();
    pending = true;
    panelFollow = true;      // sending always goes back to the end
    render();

    // Slash commands (preview): answered from the app's own data, no AI call.
    if (isPreview() && isCommand(text)) {
      let res = null;
      try { res = await runCommand(text); } catch (e) { console.warn("[coach] command failed:", e); }
      if (res && res.text == null && res.ask) {
        // "/explain <word>" the glossary lacks: ask Saathi instead.
        chatHistory[chatHistory.length - 1].text = res.ask;
      } else {
        const q = chatHistory[chatHistory.length - 1];
        const reply = { role: "assistant", text: res?.text || "That command didn't work just now. Try again in a moment.", ts: nextTs(chatHistory) };
        if (res?.card) reply.card = res.card;
        chatHistory.push(reply);
        saveChat();
        pending = false;
        logChatTurn({ userText: text, assistantText: reply.text, model: "command", surface: "side_panel", userTs: q.ts, replyTs: reply.ts });
        render();
        return;
      }
    }

    const s = getState();
    const lookupProvenance = [];

    // Streaming path for conversational messages — push placeholder bubble
    // and append tokens as they arrive. For messages that need live data
    // (stock prices, portfolio, news) we fall through to the non-streaming
    // tool-use path below.
    // chatHistory already has this turn's user message pushed, so hand the
    // heuristic the turns BEFORE it as context for short follow-ups.
    const deictic = onInstrumentPage() && DEICTIC_RE.test(text);
    if (!deictic && !needsLiveData(text, chatHistory.slice(-9, -1))) {
      abortController = new AbortController();
      const placeholderIdx = chatHistory.length;
      chatHistory.push({ role: "assistant", text: "", ts: nextTs(chatHistory), streaming: true });
      render();
      const dossier = await buildDossier();
      const newsBlock = isNewsQuestion(text) ? await prefetchNewsBlock(text) : "";
      const screen = currentScreen();
      const system = `${SAATHI_NO_TOOLS}\n\n${runtimeFacts(marketStatus())}\n\n${dossier}\n\n# RUNTIME CONTEXT\n${screen ? screen + "\n" : ""}\n\n# TONE\nKeep replies short by default (1–3 sentences). Go longer only when asked for depth.\n\nAnswer only the latest message. Do not restate prices or facts from earlier turns unless the user asks for them again.` + newsBlock + (isPreview() ? CHART_TOOL_NOTE : "") + turnLanguage();
      const messages = chatHistory.filter(m => !m.streaming || m === chatHistory[placeholderIdx]).slice(0, -1).map(m => ({
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
                  if (panelFollow) ms.scrollTop = ms.scrollHeight;
                }
              });
            }
          },
        });
      } catch (e) { console.warn("coach stream error:", e); }
      const entry = chatHistory[placeholderIdx];
      let fromStream = true;   // see the figure check below
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
        } else if (looksLikeLookupOffer(entry.text) || looksLikeFetchPromise(entry.text) || looksLikePricelessList(entry.text, text)) {
          // No tools on the streaming path, so an offer to fetch is a dead
          // end. The user already asked — go get it.
          // Also covers the bare-list shape: a long reply naming several
          // instruments with no prices, which the offer detector cannot see
          // because it caps at 400 chars. See coach/agent.js.
          const retry = await callLlmAgent(s.settings.llmApiKey || null, chatHistory, s, "", null, null, lookupProvenance).catch(() => null);
          if (retry && retry.trim()) { entry.text = retry.trim(); fromStream = false; }
        } else if (!entry.text.trim() && isToolCallOnly(result?.raw)) {
          // The model answered with nothing but a tool call — it decided it
          // needed live data on the path that has no tools wired. It was
          // right; it was just on the wrong path. Re-run the turn through
          // runAgent, which has the real tools, instead of apologising.
          const retry = await callLlmAgent(s.settings.llmApiKey || null, chatHistory, s, "", null, null, lookupProvenance).catch(() => null);
          entry.text = (retry && retry.trim())
            ? retry
            : "Let me pull that up — ask me once more?";
          fromStream = false;
        } else if (!entry.text.trim()) {
          entry.text = result?.text && result.text.trim()
            ? result.text
            : "Hmm, I went quiet there. Ask me once more?";
        }
        // C6: no tools on this path, so a price, "% today" or $/₹ event
        // figure here was made up. Redo the turn on the tool path; failing
        // that, drop those sentences.
        if (fromStream && !result?.aborted && entry.text && !entry.text.startsWith("Hmm")) {
          const figs = unsourcedFigures(entry.text, figureSources(system, messages));
          if (figs.length) {
            const redo = await Promise.race([
              callLlmAgent(s.settings.llmApiKey || null, chatHistory.filter((m) => m !== entry), s, FIGURE_RETRY_NOTE, null, null, lookupProvenance).catch(() => null),
              new Promise((r) => setTimeout(() => r(null), 12_000)),
            ]);
            if (redo && redo.trim()) entry.text = redo.trim();
            else entry.text = dropFigureSentences(entry.text, figs) || entry.text;
          }
        }
        if (!result?.aborted && entry.text && !entry.text.startsWith("Hmm")) {
          entry.text = await finishPanelReply(entry.text, text,
            () => callLlmAgent(s.settings.llmApiKey || null, chatHistory.filter((m) => m !== entry), s, LANG_RETRY_NOTE, null, null, lookupProvenance));
        }
        if (result?.finishReason === "length" && entry && !entry.text.includes("maximum generation limit")) {
          entry.text += "\n\n… [Response reached maximum generation limit. Ask \"continue\" if you'd like more.]";
        }
      }
      if (entry && entry.text) {
        const ex = extractChartMarker(entry.text);
        if (ex.text) entry.text = ex.text;
        if (ex.card && isPreview()) { entry.card = ex.card; entry.cardWithText = true; }
      }
      if (entry) {
        const provenance = normalizeLookupProvenance(lookupProvenance);
        if (provenance.length) entry.lookupProvenance = provenance;
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
          surface: "side_panel", userTs: chatHistory[placeholderIdx - 1]?.ts, replyTs: entry.ts,
          lookupProvenance,
        });
      }
      render();
      return;
    }

    // Tool-use path (live data queries): streaming via runAgent callbacks.
    abortController = new AbortController();
    const placeholderIdx = chatHistory.length;
    chatHistory.push({ role: "assistant", text: "", ts: nextTs(chatHistory), streaming: true });
    render();
    let reply = null;
    let rafPending = false;
    const onToken = (delta) => {
      if (!chatHistory[placeholderIdx]) return;
      chatHistory[placeholderIdx].text += delta;
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          const ms = root?.querySelector("#coach-messages-scroll");
          if (ms) {
            ms.innerHTML = renderMessagesHtml(getState());
            if (panelFollow) ms.scrollTop = ms.scrollHeight;
          }
        });
      }
    };
    const onStep = (step) => {
      if (!chatHistory[placeholderIdx]) return;
      if (step.type === "call") {
        const sym = step.args?.symbol || step.args?.query || "";
        const label = step.name === "get_stock_price" ? `Checking ${sym || "stock"} price…`
          : step.name === "search_stocks" ? `Searching for ${sym || "stocks"}…`
          : step.name === "get_market_news" ? `Looking up market news…`
          : step.name === "get_user_portfolio" ? `Checking your portfolio…`
          : step.name === "get_fundamentals" ? `Checking ${sym || "company"} numbers…`
          : step.name === "get_limit_orders" ? `Checking pending orders…`
          : `Checking ${step.name.replace(/_/g, " ")}…`;
        chatHistory[placeholderIdx].text = label;
        const ms = root?.querySelector("#coach-messages-scroll");
        if (ms) {
          ms.innerHTML = renderMessagesHtml(getState());
          if (panelFollow) ms.scrollTop = ms.scrollHeight;
        }
      }
    };
    try {
      reply = await callLlmAgent(s.settings.llmApiKey || null, chatHistory.filter((m, idx) => idx !== placeholderIdx), s, "", onToken, onStep, lookupProvenance);
    } catch (e) { console.warn("coach panel error:", e); }
    // If it offered to look something up instead of doing it, push once more.
    if (reply && (looksLikeLookupOffer(reply) || looksLikeFetchPromise(reply) || looksLikePricelessList(reply, text))) {
      try {
        const again = await callLlmAgent(s.settings.llmApiKey || null, chatHistory.filter((m, idx) => idx !== placeholderIdx), s, "", null, null, lookupProvenance);
        const stillBad = looksLikeLookupOffer(again) || looksLikeFetchPromise(again) || looksLikePricelessList(again, text);
        if (again && again.trim() && !stillBad) reply = again;
      } catch (e) { console.warn("coach panel lookup-offer retry:", e); }
    }
    const entry = chatHistory[placeholderIdx];
    if (entry) {
      entry.streaming = false;
      if (reply && reply.trim()) entry.text = reply;
      else if (!entry.text.trim()) entry.text = "Hmm, I can't reach my brain right now. Give it a sec and try again?";
      entry.text = await finishPanelReply(entry.text, text,
        () => callLlmAgent(s.settings.llmApiKey || null, chatHistory.filter((m) => m !== entry), s, LANG_RETRY_NOTE, null, null, lookupProvenance));
      const ex = extractChartMarker(entry.text);
      if (ex.text) entry.text = ex.text;
      if (ex.card && isPreview()) { entry.card = ex.card; entry.cardWithText = true; }
      const provenance = normalizeLookupProvenance(lookupProvenance);
      if (provenance.length) entry.lookupProvenance = provenance;
      logChatTurn({
        userText: text, assistantText: entry.text, model: "gemini-chat-tools",
        surface: "side_panel", userTs: chatHistory[placeholderIdx - 1]?.ts, replyTs: entry.ts,
        lookupProvenance,
      });
    }
    saveChat();
    pending = false;
    abortController = null;
    render();
  });

  // Intentionally NOT calling input.focus() here — render() runs on every
  // state change and every hashchange, so focusing would pop the mobile
  // virtual keyboard every time the user tapped any nav tab (even when
  // the coach panel itself is closed and off-screen). applyVisibility()
  // now does a single focus on the closed → open transition instead.
}

let panelFollow = true;   // at the end of the panel's messages
let panelScroll = 0;

const ICON = {
  copy: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="3"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  edit: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  regen: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  up: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v11H4V10z"/><path d="M7 10l4-8a3 3 0 0 1 3 3v4h5.5a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 18.2 21H7"/></svg>',
  down: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V3h3v11z"/><path d="M17 14l-4 8a3 3 0 0 1-3-3v-4H4.5a2 2 0 0 1-2-2.3l1.3-8A2 2 0 0 1 5.8 3H17"/></svg>',
};

// Preview controls in the panel: cards, the command guide, copy, feedback,
// regenerate the last reply, edit the last question. The panel keeps one
// flat log (no versions), so regenerate replaces the last reply and edit
// takes the last question back into the box.
function wirePanelExtras(ms, input) {
  const send = (text) => {
    if (pending || !input) return;
    input.value = text;
    root.querySelector("#coach-form")?.requestSubmit();
  };
  hydrateCards(ms, {
    onAsk: send, onRun: send,
    onFill: (t) => { if (!input) return; input.value = t; input.focus(); input.setSelectionRange(t.length, t.length); },
  });
  ms.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pc]");
    if (!b) return;
    const kind = b.dataset.pc;
    if (kind === "copy") {
      const m = chatHistory.find((x) => String(x.ts) === b.dataset.ts);
      try { await navigator.clipboard.writeText(m?.text || ""); b.classList.add("is-done"); setTimeout(() => b.classList.remove("is-done"), 1200); } catch {}
      return;
    }
    if (kind === "fb") {
      const m = chatHistory.find((x) => String(x.ts) === b.dataset.ts);
      if (!m) return;
      const v = +b.dataset.v;
      m.fb = m.fb === v ? 0 : v;
      if (m.fb) sendFeedback({ threadId: "side_panel", ts: m.ts, rating: v, reply: m.text });
      saveChat();
      render();
      return;
    }
    if (pending) return;
    // Both act on the last turn: drop the last question (and its reply).
    let qi = -1;
    for (let i = chatHistory.length - 1; i >= 0; i--) if (chatHistory[i]?.role === "user") { qi = i; break; }
    if (qi < 0) return;
    const q = chatHistory[qi].text;
    addPruned(chatHistory.splice(qi));
    saveChat();
    if (kind === "regen") { render(); send(q); }
    else if (kind === "edit") {
      render();
      const box = root.querySelector("#coach-input");
      if (box) { box.value = q; box.focus(); box.setSelectionRange(q.length, q.length); box.dispatchEvent(new Event("input")); }
    }
  });
}

function renderMessagesHtml(state) {
  const trade = (state.coachMessages || []).slice(-5).map(m => ({
    role: "assistant", text: m.payload?.reflection || "",
    context: m.payload?.historical_context, question: m.payload?.suggested_q,
    warning: m.payload?.warning_level, citations: m.payload?.citations || [],
    symbol: m.triggerSymbol, ts: m.ts, isTrade: true,
  })).filter(m => m.text);

  // An empty streaming placeholder shows as the typing dots, not a blank row.
  const chat = chatHistory.slice(-20).filter(m => m.role === "user" || String(m.text || "").trim()).map(m => ({ ...m, isTrade: false }));
  const all = [...trade, ...chat].sort(byTurn).slice(-25);
  const preview = isPreview();
  const lastUser = [...chat].reverse().find((m) => m.role === "user");
  const lastBot = [...chat].reverse().find((m) => m.role === "assistant" && !m.streaming);

  if (!all.length && !pending) {
    return `
      <div class="cc-empty coach-empty-cc">
        <span class="cc-avatar cc-avatar-lg" aria-hidden="true">S</span>
        <h2 class="cc-empty-title coach-empty-title">Hi, I'm Saathi</h2>
        <p class="cc-empty-text">Ask me about any stock, fund or idea, or a trade you're thinking about. I explain; I don't give tips.</p>
        <div class="cc-starters">
          ${STARTER_QUESTIONS.slice(0, 4).map(q =>
            `<button type="button" class="cc-starter" data-suggest="${escapeAttr(q)}">${escapeHtml(q)}</button>`
          ).join("")}
        </div>
        ${preview ? `<div class="cc-guide-wrap coach-guide">${guideHtml()}</div>` : ""}
      </div>
    `;
  }

  return all.map(m => {
    if (m.role === "user") {
      const acts = preview && m.ts === lastUser?.ts && !pending
        ? `<div class="cc-actions-row cc-actions-user"><button type="button" class="cc-act" data-pc="edit" aria-label="Edit message">${ICON.edit}<span>Edit</span></button></div>` : "";
      return `<div class="cc-row cc-row-user"><div class="cc-user-col"><div class="cc-bubble cc-user"><span class="msg-body">${escapeHtml(m.text)}</span></div>${acts}</div></div>`;
    }
    if (m.isTrade) {
      const lvl = m.warning === "strong_caution" ? "strong-caution" : m.warning === "caution" ? "caution" : "";
      return `
        <div class="cc-row cc-row-bot">
          <span class="cc-avatar" aria-hidden="true">S</span>
          <div class="cc-bot-col">
            <div class="coach-trade-card ${lvl}">
              <div class="coach-trade-head">
                ${m.symbol ? `<span class="pill pill-neutral" style="font-size: 10px;">${escapeHtml(m.symbol)}</span>` : ""}
                <span>On your trade · ${timeAgo(m.ts)}</span>
              </div>
              <div>${escapeHtml(m.text)}</div>
              ${m.context ? `<div class="coach-context">${escapeHtml(m.context)}</div>` : ""}
              ${m.question ? `<div class="coach-question">${escapeHtml(m.question)}</div>` : ""}
            </div>
          </div>
        </div>
      `;
    }
    const card = preview && m.card ? cardHtml(m.card) : "";
    const textHtml = `<div class="cc-bubble cc-bot ${card && !m.cardWithText ? "sr-only" : ""}"><span class="msg-body">${renderMarkdown(hideChartMarkers(m.text))}</span></div>`;
    const acts = preview && !m.streaming && m.text ? `<div class="cc-actions-row">
        <button type="button" class="cc-act" data-pc="copy" data-ts="${m.ts}" aria-label="Copy reply">${ICON.copy}</button>
        ${m.ts === lastBot?.ts && !pending ? `<button type="button" class="cc-act" data-pc="regen" aria-label="Regenerate reply">${ICON.regen}</button>` : ""}
        <button type="button" class="cc-act ${m.fb === 1 ? "is-on" : ""}" data-pc="fb" data-v="1" data-ts="${m.ts}" aria-pressed="${m.fb === 1}" aria-label="Good reply">${ICON.up}</button>
        <button type="button" class="cc-act ${m.fb === -1 ? "is-on" : ""}" data-pc="fb" data-v="-1" data-ts="${m.ts}" aria-pressed="${m.fb === -1}" aria-label="Bad reply">${ICON.down}</button>
      </div>` : "";
    return `
      <div class="cc-row cc-row-bot">
        <span class="cc-avatar" aria-hidden="true">S</span>
        <div class="cc-bot-col">${m.cardWithText ? textHtml + card : card + textHtml}${acts}</div>
      </div>
    `;
  }).join("") + (pending && !all.some(m => m.streaming) ? `
    <div class="cc-row cc-row-bot">
      <span class="cc-avatar" aria-hidden="true">S</span>
      <div class="cc-typing"><i></i><i></i><i></i></div>
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
