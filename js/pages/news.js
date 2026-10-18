// =============================================================================
// NEWS — Real-time Indian market news with sentiment + AI retail-angle tag.
// =============================================================================

import { getNews, fmtRelativeTime, labelSentiment, withUtm, withoutUtm, findSameStory } from "../data/news.js";
import { track } from "../features/track.js";
import { getState, subscribe } from "../state.js";
import { aiLang } from "../features/aiLang.js";
import { ensureUniverseLoaded, getAllInstruments } from "../data/universeLoader.js";

// Tickers the AI names are only linked when they are real listed symbols.
let knownSymbols = null;
function isKnownSymbol(t) {
  if (!knownSymbols) {
    const all = getAllInstruments();
    if (all.length < 1000) return false;   // full list not loaded yet
    knownSymbols = new Set(all.map(i => i.symbol));
  }
  return knownSymbols.has(t);
}

let filter = "all";    // all | holdings | watchlist
let newsCache = [];
// Cards rendered so far. /api/news returns a few hundred items; drawing all
// of them at once is slow on phones, so the page shows a page at a time.
const PAGE_SIZE = 30;
let shownCount = PAGE_SIZE;
let observer = null;
let loading = true;
let _newsCancel = { cancelled: false };
// AI-tag memo: { [headlineHash]: { sentiment, tldr, loading } }. Keyed on
// the headline text itself so duplicates across sources dedupe naturally.
const aiTags = new Map();
let aiTagsLang = null;
let aiQueueRunning = 0;
// Concurrency = 4. Now that we ONLY queue items the user is actually
// staring at (viewport-strict observer + 350 ms dwell debounce + abort
// on scroll-out), a typical viewport never has more than ~4-5 cards on
// screen at once — so 4 parallel fetches is plenty and leaves headroom
// against rate limits. Keeping above 4 is wasted budget.
const AI_MAX_CONCURRENT = 4;
const aiQueue = [];

// AbortController + debounce-timer plumbing per headline-key.
//   debounceTimers: cards must be visible for 350 ms before they queue,
//     so a fast scroll-past doesn't fire any API calls.
//   aborters: every queued/in-flight job has a controller; if the card
//     scrolls out of view before completion, ctrl.abort() cancels it
//     and the queue slot is freed via the existing .finally in pumpAiQueue.
const debounceTimers = new Map();
const aborters = new Map();
const VIEWPORT_DWELL_MS = 350;

// Saathi takes this browser has already seen, so a reload shows them with no
// request at all. /api/news also attaches every take stored server-side, so
// a new visitor gets them instantly too; this covers the ≤10 min before the
// CDN copy of the feed picks up a take generated a moment ago.
// v2: takes written from the articles. v1 held headline-only takes.
const TAKES_LS = "ss_news_takes_v2";
const TAKES_MAX = 800;
try { localStorage.removeItem("ss_news_takes_v1"); } catch {}
function loadStoredTakes() {
  try { return JSON.parse(localStorage.getItem(TAKES_LS) || "{}") || {}; } catch { return {}; }
}
function storeTake(hk, sentiment, tldr, impacts) {
  try {
    const all = loadStoredTakes();
    all[langTag() + hk] = { s: sentiment, t: tldr, i: impacts || [], at: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > TAKES_MAX) {
      keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
      for (const k of keys.slice(0, keys.length - TAKES_MAX)) delete all[k];
    }
    localStorage.setItem(TAKES_LS, JSON.stringify(all));
  } catch {}
}
function langTag() { return aiLang() ? "hi:" : ""; }

// Fill aiTags from the feed's server-side takes and this browser's store.
function seedTakes(items) {
  const stored = loadStoredTakes();
  const tag = langTag();
  for (const n of items) {
    const hk = headlineKey(n.headline);
    if (aiTags.get(hk)?.tldr) continue;
    if (n.take?.tldr) {
      aiTags.set(hk, { sentiment: n.take.sentiment || "neutral", tldr: n.take.tldr, impacts: n.take.impacts || [], loading: false });
    } else if (stored[tag + hk]?.t) {
      const s = stored[tag + hk];
      aiTags.set(hk, { sentiment: s.s || "neutral", tldr: s.t, impacts: s.i || [], loading: false });
    }
  }
}

// Stocks a story is about: the keyword matcher's tickers plus every listed
// company the Saathi take judged. Drives the holdings / watchlist tabs.
function storyTickers(n) {
  const fromAi = (aiTags.get(headlineKey(n.headline))?.impacts || []).map(x => x.ticker);
  return [...(n.symbols || []), ...fromAi];
}

export function renderNews(main) {
  _newsCancel.cancelled = true;
  _newsCancel = { cancelled: false };
  const myToken = _newsCancel;

  loading = true;
  render(main);
  loadNews(main, myToken);
  // Once the full stock list is in, AI-named tickers become links.
  ensureUniverseLoaded()?.then?.(() => {
    knownSymbols = null;
    if (!myToken.cancelled && !loading) render(main);
  }).catch?.(() => {});
  const unsub = subscribe(() => { if (!myToken.cancelled) render(main); });
  const onLeave = () => { myToken.cancelled = true; unsub?.(); };
  window.addEventListener("ss:navigate", onLeave, { once: true });
}

async function loadNews(main, token, force = false) {
  try {
    const items = await getNews({ limit: 1000, lang: aiLang() ? "hi" : "", force });
    if (token.cancelled) return;
    // Hinglish takes and English takes are different texts under the same
    // headline; drop what's held if the language changed since last load.
    if (aiTagsLang !== langTag()) { aiTags.clear(); aiTagsLang = langTag(); }
    seedTakes(items);
    newsCache = items;
    shownCount = PAGE_SIZE;
  } catch (e) {
    if (token.cancelled) return;
    console.warn("news load failed:", e);
    newsCache = [];
  }
  if (token.cancelled) return;
  loading = false;
  render(main);
}

function render(main) {
  const state = getState();
  const holdings = Object.keys(state.holdings || {});
  const wl = state.watchlist || [];

  let visible = newsCache;
  if (filter === "holdings") {
    if (holdings.length === 0) {
      visible = [];
    } else {
      visible = newsCache.filter(n => storyTickers(n).some(s => holdings.includes(s)));
    }
  } else if (filter === "watchlist") {
    if (wl.length === 0) {
      visible = [];
    } else {
      visible = newsCache.filter(n => storyTickers(n).some(s => wl.includes(s)));
    }
  }

  const countAll = newsCache.length;
  const countHoldings = holdings.length ? newsCache.filter(n => storyTickers(n).some(s => holdings.includes(s))).length : 0;
  const countWatchlist = wl.length ? newsCache.filter(n => storyTickers(n).some(s => wl.includes(s))).length : 0;

  main.innerHTML = `
    <div style="margin-bottom: var(--sp-5);">
      <div class="flex items-center gap-3 wrap">
        <h1>Market News</h1>
        <span class="data-badge"><span class="dot ${loading ? "offline" : ""}"></span> ${loading ? "Loading…" : "Live from RSS"}</span>
        <button class="btn btn-ghost btn-sm" id="refresh-btn">↻ Refresh</button>
      </div>
      <p class="muted">Headlines from Economic Times, LiveMint, Business Standard, BusinessLine, CNBC-TV18, NDTV Profit, Business Today, The Hindu and Indian Express. Each Saathi take is written from the full article and the same story from other publishers. Click a story to open the original article.</p>
    </div>

    <div class="flex gap-2 wrap" style="margin-bottom: var(--sp-4);">
      <div class="lb-tabs">
        <button class="lb-tab ${filter === "all" ? "active" : ""}" data-filter="all">All news (${countAll})</button>
        <button class="lb-tab ${filter === "holdings" ? "active" : ""}" data-filter="holdings">My holdings (${countHoldings})</button>
        <button class="lb-tab ${filter === "watchlist" ? "active" : ""}" data-filter="watchlist">Watchlist (${countWatchlist})</button>
      </div>
    </div>

    ${loading
      ? `<div class="news-grid compact">${[1,2,3,4].map(() => `<div class="news-item"><div class="skeleton" style="height: 18px; width: 80%;"></div><div class="skeleton" style="height: 14px; width: 100%; margin-top: 12px;"></div><div class="skeleton" style="height: 14px; width: 60%; margin-top: 8px;"></div></div>`).join("")}</div>`
      : (visible.length === 0
        ? `<div class="empty-state"><span class="emoji">📰</span><h3>${filter === "all" ? "Couldn't load news" : filter === "holdings" ? "No news about your holdings" : "No news about your watchlist"}</h3><p>${filter === "all" ? "Market news feeds are temporarily unreachable. Try refreshing in a minute." : filter === "holdings" ? (holdings.length ? "None of your holdings are in the latest news cycle." : "Buy some stocks first — news will filter here automatically.") : (wl.length ? "None of your watchlist stocks are in the latest news cycle." : "Add stocks to your watchlist (★ icon) — news will filter here automatically.")}</p></div>`
        : `<div class="news-grid compact">${visible.slice(0, shownCount).map(renderNewsItem).join("")}</div>
           ${visible.length > shownCount
             ? `<div style="text-align: center; margin-top: var(--sp-4);"><button class="btn btn-ghost" id="news-more-btn">Show more (${visible.length - shownCount} left)</button></div>`
             : ""}`)
    }
  `;

  main.querySelectorAll("[data-filter]").forEach(btn => {
    btn.addEventListener("click", () => { filter = btn.dataset.filter; shownCount = PAGE_SIZE; render(main); });
  });
  main.querySelector("#news-more-btn")?.addEventListener("click", () => {
    shownCount += PAGE_SIZE;
    render(main);
  });
  main.querySelector("#refresh-btn")?.addEventListener("click", () => {
    loading = true;
    render(main);
    loadNews(main, _newsCancel, true);
  });

  main.querySelectorAll("[data-newsurl]").forEach(el => {
    el.addEventListener("click", (e) => {
      // A stock chip inside the card goes to our stock page, not the article.
      if (e.target.closest("[data-stock-link]")) return;
      e.preventDefault();
      const url = withUtm(el.dataset.newsurl);
      // The headline, not the URL, is what the coach can talk about.
      track("news_click", el.getAttribute("aria-label") || url, {
        host: (() => { try { return new URL(url).hostname; } catch { return null; } })(),
      });
      // noopener, not noreferrer: the publisher also gets our origin as the
      // Referer (the site-wide policy sends only https://stocksaathi.co.in/).
      if (url && url !== "#") window.open(url, "_blank", "noopener");
    });
  });

  // Strict viewport-aware AI tagging.
  //   - rootMargin: "0px" so we never pre-fire items below the fold.
  //   - threshold: [0, 0.25, 0.5] so a card needs to be at least 25 %
  //     visible before it counts (handles tall mobile cards in tight
  //     viewports without false-firing on a sliver entering the screen).
  //   - 350 ms dwell debounce — a card has to STAY visible long enough
  //     to imply the user is reading it, not just scrolling past.
  //   - on isIntersecting=false: cancel the dwell timer, splice from the
  //     queue if not yet running, abort the fetch if already in flight.
  //   - cards remain observed until their fetch SUCCEEDS, so a scroll-
  //     back-up triggers a fresh queue.
  const visibleMap = new Map(visible.slice(0, shownCount).map(n => [headlineKey(n.headline), n]));
  // Each render replaces the cards, so the old observer only watches
  // detached nodes; drop it rather than letting them pile up.
  if (observer) observer.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const el = entry.target;
      const hk = el.dataset.aiHk;
      if (!hk) continue;
      const n = visibleMap.get(hk);
      if (!n) continue;
      const isVisible = entry.isIntersecting && entry.intersectionRatio >= 0.25;
      if (isVisible) {
        // Already tagged or in flight? Skip.
        const existing = aiTags.get(hk);
        if (existing && (existing.tldr || existing.loading)) continue;
        // Start the dwell timer.
        if (debounceTimers.has(hk)) continue;
        const t = setTimeout(() => {
          debounceTimers.delete(hk);
          enqueueAiTag(main, n);
        }, VIEWPORT_DWELL_MS);
        debounceTimers.set(hk, t);
      } else {
        // Cancel anything pending for this card.
        const t = debounceTimers.get(hk);
        if (t) { clearTimeout(t); debounceTimers.delete(hk); }
        // Splice from the queue if it's still waiting.
        const qIdx = aiQueue.findIndex(j => j.hk === hk);
        if (qIdx >= 0) aiQueue.splice(qIdx, 1);
        // Abort in-flight fetch.
        const ctrl = aborters.get(hk);
        if (ctrl) { try { ctrl.abort(); } catch {} aborters.delete(hk); }
        // Reset state so re-entry can re-queue cleanly.
        if (aiTags.get(hk)?.loading) aiTags.set(hk, {});
      }
    }
  }, { rootMargin: "0px", threshold: [0, 0.25, 0.5] });
  main.querySelectorAll("[data-ai-hk]").forEach(el => observer.observe(el));
}

function renderNewsItem(n) {
  const hk = headlineKey(n.headline);
  const ai = aiTags.get(hk);
  const aiBlock = ai && ai.tldr
    ? `<div class="news-ai-take sentiment-${escapeAttr(ai.sentiment)}" data-ai-hk="${escapeAttr(hk)}">${takeInner(ai)}</div>`
    : `<div class="news-ai-take loading" data-ai-hk="${escapeAttr(hk)}"><span class="news-ai-label">Saathi take</span><span class="news-ai-body dim">Analysing…</span></div>`;
  return `
    <article class="news-item" data-newsurl="${escapeAttr(n.url)}" tabindex="0" role="link" aria-label="${escapeAttr(n.headline)}">
      <div class="meta">
        <span class="news-source">${escapeHtml(n.source)} · ${fmtRelativeTime(n.ts)}</span>
        <span class="sentiment ${ai?.sentiment || n.sentiment}">${labelSentiment(ai?.sentiment || n.sentiment)}</span>
      </div>
      <div class="headline">${escapeHtml(n.headline)}</div>
      ${n.summary ? `<div class="summary">${escapeHtml(n.summary)}</div>` : ""}
      ${aiBlock}
      <div class="flex gap-1 wrap items-center justify-between" style="margin-top: 6px;">
        ${n.symbols?.length ? `<div class="flex gap-1 wrap">${n.symbols.slice(0, 4).map(s => `<span class="pill pill-neutral" style="font-size: 10px;">${s}</span>`).join("")}</div>` : `<span></span>`}
        ${n.url && n.url !== "#" ? `<span class="text-xs brand">Read →</span>` : ""}
      </div>
    </article>
  `;
}

// Take text plus one chip per listed company the AI judged: ▲ good for that
// stock, ▼ bad, • no clear effect; hover shows its one-line reason. Real
// tickers link to their stock page.
function takeInner(ai) {
  const chips = (ai.impacts || []).map(x => {
    const eff = ["bullish", "bearish"].includes(x.effect) ? x.effect : "neutral";
    const label = `${escapeHtml(x.ticker)} ${eff === "bullish" ? "▲" : eff === "bearish" ? "▼" : "•"}`;
    const title = escapeAttr(x.why || labelSentiment(eff));
    return isKnownSymbol(x.ticker)
      ? `<a class="sentiment ${eff}" data-stock-link href="/stocks/${encodeURIComponent(x.ticker)}" title="${title}" style="text-decoration: none;">${label}</a>`
      : `<span class="sentiment ${eff}" title="${title}">${label}</span>`;
  }).join("");
  return `<span class="news-ai-label">Saathi take</span><span class="news-ai-body">${escapeHtml(ai.tldr)}${
    chips ? `<span class="news-ai-impacts" style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;">${chips}</span>` : ""}</span>`;
}

function headlineKey(headline) {
  return String(headline || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

function enqueueAiTag(main, n) {
  const hk = headlineKey(n.headline);
  if (!hk) return;
  const existing = aiTags.get(hk);
  if (existing && (existing.tldr || existing.loading)) return;
  aiTags.set(hk, { loading: true });
  // Create the AbortController NOW (not inside fetchAiTag) so the
  // observer can find and abort it the instant the card scrolls out
  // of view, even before the queue slot opens up.
  const ctrl = new AbortController();
  aborters.set(hk, ctrl);
  aiQueue.push({ main, n, hk, ctrl });
  pumpAiQueue();
}

async function pumpAiQueue() {
  while (aiQueueRunning < AI_MAX_CONCURRENT && aiQueue.length) {
    const job = aiQueue.shift();
    aiQueueRunning++;
    fetchAiTag(job).finally(() => {
      aiQueueRunning--;
      pumpAiQueue();
    });
  }
}

async function fetchAiTag({ main, n, hk, ctrl }) {
  // The AbortController was created in enqueueAiTag and stored in the
  // aborters Map so the IntersectionObserver can find and abort it the
  // moment the card scrolls out of view. We layer on a 25 s timeout so
  // a hung endpoint can't leave a stuck skeleton even for a card the
  // user is still looking at. (A first-time take reads up to five articles
  // before writing, so it needs longer than the old headline-only one.)
  const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, 25000);
  try {
    // The server reads the article and the same story from up to four other
    // publishers in our list. Links go without our UTM tags: those fetches
    // are not readers we sent.
    const related = findSameStory(n, newsCache, 4).map(o => ({
      headline: o.headline, source: o.source, summary: o.summary || "", url: withoutUtm(o.url),
    }));
    const r = await fetch("/api/ai?op=news-tldr" + aiLang(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        headline: n.headline, source: n.source, symbols: n.symbols || [],
        summary: n.summary || "", url: withoutUtm(n.url), related,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error("http_" + r.status);
    const j = await r.json();
    if (!j?.tldr) throw new Error("no_tldr");
    aiTags.set(hk, { sentiment: j.sentiment || "neutral", tldr: j.tldr, impacts: j.impacts || [], loading: false });
    storeTake(hk, j.sentiment || "neutral", j.tldr, j.impacts || []);
    patchNewsItem(main, hk);
  } catch (e) {
    clearTimeout(timer);
    const isAbort = e?.name === "AbortError";
    if (!isAbort) console.warn("[news-tldr] failed for", n.headline?.slice(0, 40), "·", e?.name || e?.message || e);
    // For abort: just clear loading, leave the skeleton in place — if the
    // user scrolls back the observer will re-queue. For real errors:
    // remove the skeleton so the card falls back to headline-only.
    aiTags.set(hk, isAbort ? {} : { loading: false });
    if (!isAbort) {
      const el = main?.querySelector(`[data-ai-hk="${cssEscape(hk)}"]`);
      if (el) el.remove();
    }
  } finally {
    aborters.delete(hk);
  }
}

function patchNewsItem(main, hk) {
  const ai = aiTags.get(hk);
  if (!ai || !ai.tldr) return;
  const el = main?.querySelector(`[data-ai-hk="${cssEscape(hk)}"]`);
  if (!el) return;
  el.className = `news-ai-take sentiment-${ai.sentiment}`;
  el.innerHTML = takeInner(ai);
  // Also update the top-right sentiment pill on the same card to match
  // what the AI concluded (often more accurate than the keyword-based
  // sentiment from data/news.js).
  const card = el.closest(".news-item");
  const sentPill = card?.querySelector(".sentiment");
  if (sentPill) {
    sentPill.className = `sentiment ${ai.sentiment}`;
    sentPill.textContent = labelSentiment(ai.sentiment);
  }
}

function cssEscape(s) {
  if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
  return String(s).replace(/"/g, '\\"');
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
