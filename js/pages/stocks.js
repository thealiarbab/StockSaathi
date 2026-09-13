// =============================================================================
// STOCKS — Browse markets. Real-time prices via Yahoo Finance when possible.
// =============================================================================

import { STOCKS, MUTUAL_FUNDS, SECTORS, INSTRUMENTS, getAllInstruments, getAllSectors, getInstrument, ensureUniverseLoaded, ensureMfUniverseLoaded, getMfCategoryBuckets, getCanonicalCategory, getCanonicalCategoryCounts } from "../data/universe.js";
import { getTodayChange, getCloses, marketStatus, get52wRange } from "../data/prices.js";
import { getQuoteBatch, getDataSource, subscribeToQuotes, getCachedQuotes, getFreshCachedQuotes, getIntradaySparkline } from "../data/marketData.js";
import { sparkline } from "../components/charts.js";
import { formatRupees, formatPct, deltaClass } from "../money.js";
import { getState, addToWatchlist, removeFromWatchlist, subscribe } from "../state.js";
import { toast } from "../components/toast.js";

// Default tab = Stocks (showing the full universe sorted by index prominence
// — Nifty 50/100 stocks naturally land on top). No Featured/All split.
// `mfBucket` and `mfPlan` are MF-tab-only filters — preserved across tab
// switches so coming back to Mutual Funds keeps the user's last view.
// Hotfix64b: default sort = name A→Z. User wanted "every stock arranged in
// ALPHABETICAL ORDER" both in the all-sectors view and inside any category.
// Power users can still flip to "Top by size" / Gainers / Losers via the
// dropdown — sticky across pill clicks like before.
let filter = { q: "", sector: "all", kind: "EQUITY", sort: "name", mfBucket: "all", mfPlan: "all" };

// Hotfix65a: view mode for /stocks grid. "tiles" (Groww-style compact
// rows, default) or "cards" (the original detailed cards). Persisted in
// localStorage so user preference survives reloads. Single-className
// flip on the grid container — preserves IntersectionObserver hydration
// + live-tick patching + click delegation since the row HTML and
// .stock-card[data-sym] selector are identical in both modes.
const VIEW_MODE_KEY = "ss.stocks-view";
function loadViewMode() {
  try { return localStorage.getItem(VIEW_MODE_KEY) === "cards" ? "cards" : "tiles"; }
  catch { return "tiles"; }
}
function saveViewMode(m) {
  try { localStorage.setItem(VIEW_MODE_KEY, m); } catch {}
}
let viewMode = loadViewMode();
let quoteCache = {};
let marketMood = null;       // { narrative, temperature } | null
let _moodFetched = false; // true after first /api/market-mood resolves
let aiSearch = null;          // { matches: ["TCS", ...], rationale: "..." } | null — when present, overrides the normal filter pipeline
let aiSearchLoading = false;
let aiSearchQuery = "";
let aiSearchAbort = null;     // AbortController for the in-flight /api/ai call
let visibleCount = 100;       // pagination window — grows with "Show more"
const PAGE_SIZE = 100;
// Magic-number extraction: how many visible cards the viewport-preheat
// (Hotfix21b) and warm-up-from-observer (Hotfix22a) both fetch up front.
// Set to 60 = ~24 visible cards × 2.5 scroll buffer. Lifted to a named
// const so future changes don't have to hunt for both call sites.
const VIEWPORT_PREHEAT_SIZE = 60;
// 3-second fail-open timeout: if the viewport-preheat batch hasn't
// resolved within this window we drop the skeleton anyway and let the
// post-render warm-up flow fill prices. Prevents a hung upstream API
// from holding the skeleton indefinitely on slow networks.
const PREHEAT_FAIL_OPEN_MS = 3000;
// IntersectionObserver rootMargin values. Hydrate observer uses 200%
// (cards within 2 viewport heights of visible region get warmed up).
// Dehydrate observer uses 600% (cards 6 viewport heights past visible
// get torn back down to stubs to free DOM memory). Both deduced from
// Hotfix7's analysis of "Show all 13,969" leaving 13k hydrated cards.
const HYDRATE_ROOT_MARGIN = "200% 0px 200% 0px";
const DEHYDRATE_ROOT_MARGIN = "600% 0px 600% 0px";
// 2-second fail-open timeout for the mood banner. If the LLM mood call
// is still inflight, drop the gate and let the banner appear later when
// the fetch resolves. Keeps cold loads under the 2s perceived-instant
// threshold even when the mood endpoint is slow.
const MOOD_FAIL_OPEN_MS = 2000;
// Instrument-kind strings. Universe.json uses these as discriminator
// values for stocks.kind. Hoisted to consts so typos at usage sites
// are syntax errors at write time rather than silent never-matches.
const KIND_MF = "MF";
const KIND_EQUITY = "EQUITY";
const KIND_ETF = "ETF";

// Hotfix46c: terminated-MF detector. Same logic as stockDetail.js's
// isTerminatedFund() â€” mirrored here so applyFilters can filter the
// default MF universe without importing across modules. nav < 0.01
// catches AMFI's floor-rounded post-maturity 0.0001 values (e.g.
// Kotak Monthly Interval Plan Series 4); nav_date > 365 days catches
// the long tail of zombie schemes that simply stopped publishing.
function _isMfTerminated(inst) {
  if (!inst || inst.kind !== "MF") return false;
  const nav = typeof inst.nav === "number" ? inst.nav : null;
  if (nav != null && nav < 0.01) return true;
  if (inst.nav_date) {
    const dt = new Date(inst.nav_date);
    if (!isNaN(dt) && (Date.now() - dt.getTime()) / 86400000 > 365) return true;
  }
  return false;
}
// Seeded sparkline window: how many close-prices to feed into sparkline().
// 40 ticks at ~5 min intervals ~= 200 min ~= a full trading session of
// the post-Hotfix9 5-minute resampled series. Lifted to a const so all
// 5 callsites share one source of truth.
const SPARKLINE_SEED_LENGTH = 40;
// Cold-start seed cap (top-N by sort order). 30 is a tighter slice than
// VIEWPORT_PREHEAT_SIZE (60) â€” the cold-start IIFE just needs enough
// to fill the visible viewport, not the scroll buffer too.
const COLD_START_SEED = 30;
// Threshold on quoteCache size before the page asks Gemini for a market
// mood narrative. <30 means "not enough signal yet"; the LLM banner
// would just see noise.
const MOOD_FETCH_QUOTE_THRESHOLD = 30;
// Threshold for considering the fresh-cache "good enough" to skip the
// cold-start gate. >=5 ensures we don't accidentally count an empty
// cache as ready (which would briefly show skeleton-priced cards).
const FRESH_CACHE_READY_THRESHOLD = 5;
// Live-quote subscription cadence. 10 s matches Yahoo Finance's
// effective tick rate during market hours; faster polling adds load
// without giving us new prices.
const QUOTE_POLL_INTERVAL_MS = 10_000;
let _debounceTimer = null;

// Visible-symbols set + observer for viewport-only polling. Populated as
// IntersectionObserver fires; consumed by symbolsToPoll() callback inside
// renderStocks(). Cleared on hashchange leave.
//
// Two observers cooperate:
//   _cardObserver — narrow rootMargin (200%), drives hydration on entry
//                   and viewport-set tracking for live-quote polling.
//   _dehydrateObserver — wide rootMargin (-300% — only fires when the
//                   card is at least 3 viewport heights past the visible
//                   region), restores hydrated cards to stubs to free
//                   DOM memory. Without this, "Show all 13,969" leaves
//                   13k fully-hydrated cards in DOM forever.
let _visibleSymbols = new Set();
let _cardObserver = null;
let _dehydrateObserver = null;

// Keywords that let the Ask-Saathi prefilter narrow a 2k-candidate pool down
// to ~150 without sending everything to the LLM. Maps lowercase tokens to
// filter predicates applied against the full-universe row shape.
const CAP_KEYWORDS = {
  largecap: ["mega", "large"], "large cap": ["mega", "large"], "large-cap": ["mega", "large"],
  "tier 1": ["mega", "large"], "tier1": ["mega", "large"], "top tier": ["mega", "large"],
  midcap: ["mid"], "mid cap": ["mid"], "mid-cap": ["mid"],
  "tier 2": ["mid"], "tier2": ["mid"], "second tier": ["mid"],
  smallcap: ["small", "micro"], "small cap": ["small", "micro"], "small-cap": ["small", "micro"],
  "low cap": ["small", "micro"], "low-cap": ["small", "micro"],
  microcap: ["micro"], "micro cap": ["micro"], "micro-cap": ["micro"],
  penny: ["micro"], "penny stock": ["micro"],
  bluechip: ["mega"], "blue chip": ["mega"], "blue-chip": ["mega"],
  nifty50: ["mega"], "nifty 50": ["mega"], "top 50": ["mega"], "top 100": ["mega", "large"],
};
const RISK_KEYWORDS = {
  safe: "low", stable: "low", defensive: "low", steady: "low",
  conservative: "low", boring: "low", "low risk": "low", "low-risk": "low",
  risky: "high", volatile: "high", speculative: "high", aggressive: "high",
  punt: "high", "high risk": "high", "high-risk": "high", momentum: "high",
  moderate: "med", balanced: "med", "medium risk": "med",
};

export function renderStocks(main) {
  let cancelled = false;
  let pollUnsub = null;
  // One-shot flag — first batch of viewport-visible symbols triggers an
  // immediate getQuoteBatch so users see prices instantly. Subsequent
  // scroll changes piggy-back on the 10s subscribeToQuotes cycle.
  let _warmedFromObserver = false;
  // Tier-2 universe readiness — flipped true the moment universeFull.json
  // has populated getAllInstruments() with thousands of rows. Pre-fix the
  // skeleton-vs-real gate used `allInst.length > STOCKS.length`, which
  // misfired because curated.js still ships 10 placeholder MFs that
  // counted toward `allInst.length` (126 > 116 → "ready" before the
  // 16,665-row universe blob actually landed). User-reported via 5-frame
  // OBS capture: page flashed 116 featured stocks first, then re-rendered
  // alphabetically with the full 2,364-equity universe but no prices yet,
  // then prices arrived, then the mood banner appeared. Each transition
  // was a visible jank step. Proper signal is below — wired in 19c.
  let _universeLoaded = getAllInstruments().length > 1000;
  // First-batch quote readiness — flipped true the moment the warm-up
  // getQuoteBatch() at line ~210 resolves with prices for the initial
  // viewport (cold-start seed = top-30 by index prominence). Without
  // this signal the skeleton would drop the moment universeFull lands
  // (Hotfix19a) but the freshly-rendered cards would still show
  // "Loading…" skeleton bars in their price slots for another 1-3 s
  // until quotes arrived (frame 2 of the OBS capture). Pre-flagged
  // true if quoteCache already covers most of the cold-start seed
  // from getFreshCachedQuotes() — repeat visits within 30 s of the
  // last poll get instant prices and shouldn't artificially gate on
  // a fresh fetch they don't need.
  let _initialQuotesLoaded = false;
  // Mood-banner readiness — flipped true either when fetchMarketMood()
  // resolves with a narrative OR when the 2-second budget expires (the
  // banner is "nice to have" UX; we never want to gate the entire page
  // on a slow LLM call). Pre-fix the mood card appeared 1-2 s after the
  // skeleton dropped, pushing every card on the page down by 90 px and
  // producing the visible layout shift in frame 4 of the OBS capture.
  // Now the skeleton holds until mood is either ready or timed out, so
  // when the real grid renders it does so WITH the mood banner already
  // in place — no shift, no flash.
  let _moodReady = false;
  // Viewport preheat readiness — flipped true once a getQuoteBatch covering
  // the post-universeFull-loaded "top 60 by sort order" symbols has returned.
  // Pre-fix the page rendered the moment universe + cold-start-batch were
  // ready (Hotfix19c) but the cold-start seed was computed against curated
  // (≤126 symbols) BEFORE universeFull loaded. Once the full universe
  // landed, the visible top of the sort changed — cards entering the
  // viewport that weren't in the curated cold-start hydrated as skeleton
  // and only filled in when the warm-up-from-observer batch resolved
  // 1–3 s later. User-reported staircase: skeleton → cards-with-no-prices
  // → cards-with-prices. This flag (wired into the gate by 21b.3) holds
  // the skeleton until quotes for the actual visible viewport are loaded.
  let _viewportPreheatDone = false;
  // Hotfix27a removed the 2-second mood fail-open timer. _moodReady is
  // no longer in pageReady() so there's nothing to fail open against â€”
  // mood resolves whenever the LLM call finishes, and the surgical DOM
  // update fills the #market-mood-slot. Saves 1.5 s on cold loads where
  // mood was the slowest gate to flip.

  // Reset transient state on every (re-)entry so a stale in-flight AI
  // fetch or broken loading flag from the previous session doesn't leak
  // into this one. Filter + quoteCache + marketMood persist across
  // navigation on purpose — the user gets back exactly where they left off.
  aiSearchLoading = false;
  if (aiSearchAbort) { try { aiSearchAbort.abort(); } catch {} aiSearchAbort = null; }
  visibleCount = PAGE_SIZE;

  // Nudge the full universe to load if it hasn't already — no-op if cached
  // or already in flight. Kicks the JSON fetch early so the "All NSE" pill
  // is click-ready by the time the user scans the toolbar.
  ensureUniverseLoaded();
  // Eager-load MF universe always — cold-load cost is ~250 KB brotli +
  // ~1 s on a fast connection. Without this, the Mutual Funds pill
  // shows "(10)" (legacy placeholder count) until the user clicks
  // the pill, which forces them to click twice to see the real list.
  // User-reported confusing UX: "MF still shows 10 until the pill is
  // clicked". Now the count populates within ~1-2 s of page load.
  ensureMfUniverseLoaded();
  // Also re-render once AMFI lands so the count pills + grid update.
  const onMfLoaded = () => {
    if (cancelled) return;
    // Hotfix55a: previously this skipped the render when pageReady
    // was already true (Hotfix23f) â€” to avoid wiping the hydrated
    // grid for a count-pill update. But that meant the 'Mutual Funds
    // (10)' pill stayed at the curated placeholder count forever
    // (until the user happened to click it). User-reported.
    // Better fix: surgically update JUST the count text on the MF
    // tab pill + the markets header counts, leaving the grid alone.
    // Falls through to a full render() only when pageReady is false
    // (skeleton is still up).
    const wasReady = pageReady();
    if (!wasReady) { render(); return; }
    // Surgical DOM update path. Re-derive the active MF count and
    // patch the visible label.
    try {
      const allInst = getAllInstruments();
      const equityCt = allInst.filter(i => i.kind === KIND_EQUITY).length;
      const etfCt    = allInst.filter(i => i.kind === KIND_ETF).length;
      const mfActive = allInst.filter(i => i.kind === KIND_MF && !_isMfTerminated(i)).length;
      // Hotfix61a: total = sum of the VISIBLE breakdown, not allInst.length.
      // Raw rows include 5,000+ wound-up zombie MF schemes that we hide
      // from the grid via _isMfTerminated, so a "16,665 instruments"
      // headline followed by "8,741 mutual funds" didn't add up. Total
      // now equals what the user can actually browse below.
      const total    = equityCt + etfCt + mfActive;
      const fmt = (n) => n.toLocaleString("en-IN");
      const mfPill = main.querySelector('[data-kind="MF"]');
      if (mfPill && mfActive) mfPill.textContent = `Mutual Funds (${fmt(mfActive)})`;
      const subtitle = main.querySelector("h1 + p.muted");
      if (subtitle) {
        const parts = [`${fmt(total)} instruments`];
        if (equityCt) parts.push(`${fmt(equityCt)} stocks`);
        if (etfCt)    parts.push(`${fmt(etfCt)} ETFs`);
        if (mfActive) parts.push(`${fmt(mfActive)} mutual funds`);
        subtitle.textContent = parts.join(" · ");   // U+00B7
      }
    } catch (e) {
      // If anything goes wrong with the surgical patch, fall back to
      // a full render â€” a brief grid blink is better than stale text.
      console.warn("[onMfLoaded surgical update]", e);
      render();
    }
  };
  window.addEventListener("ss:mf-universe-loaded", onMfLoaded);

  // Single source: the full merged Tier-1 + Tier-2 universe (~2700 rows).
  // No Featured / All-NSE distinction — the kind pill (Stocks / ETFs / MFs /
  // Watchlist) decides which slice the user sees, and the default sort by
  // index prominence (Nifty 50/100 first) puts the famous names on top
  // organically. This matches Groww / Zerodha Kite / Upstox UX.
  function source() {
    return getAllInstruments();
  }

  // Prefill from in-memory cache SYNCHRONOUSLY so the very first paint
  // shows last-known REAL-FRESH prices (not universe placeholders, and
  // not stale localStorage-persisted quotes from hours/days ago).
  // getFreshCachedQuotes: during market hours, only returns cache entries
  // younger than 30s whose upstream timestamp wasn't stale either. Outside
  // market hours, returns whatever we have (yesterday's close is truth).
  // Anything that's missing or stale falls through to skeleton cards in
  // renderStockCard until the first getQuoteBatch() returns below.
  const allSyms = INSTRUMENTS.map(i => i.symbol);
  quoteCache = { ...quoteCache, ...getFreshCachedQuotes(allSyms) };
  // Pre-flag _initialQuotesLoaded true if the fresh-cache already covers
  // a meaningful slice of cold-start symbols. Without this, repeat visits
  // within 30 s of the last poll would gate on a fresh batch they don't
  // need, briefly showing the skeleton even though all the prices the
  // user is about to see are already in cache. Threshold 5 is below the
  // cold-start seed of 30 (line ~200) so we don't accidentally count an
  // empty cache as ready.
  if (Object.keys(quoteCache).length >= FRESH_CACHE_READY_THRESHOLD) _initialQuotesLoaded = true;

  render();
  // Subscribe with a state-slice diff so we only re-render when something
  // RELEVANT to the stocks page changes — watchlist membership, signed-in
  // user, or holdings (for watchlist stars + portfolio P&L tooltips).
  //
  // Pre-fix this listener fired render() on EVERY state emit, including:
  //   - setSetting("coachPanelOpen", true)  — opening the coach FAB
  //   - setSetting("theme", "dark")          — flipping the dark-mode toggle
  //   - recordCoachMessage(msg)              — every coach intro / bias alert
  //   - applyTrade(...)                      — trades placed on detail page
  //   - cross-tab `storage` events           — any tab writing user state
  //
  // Each render() did `main.innerHTML = ...` which wiped every hydrated
  // card back to a skeleton stub, then the IntersectionObserver had to
  // re-fire and re-hydrate everything. That's the user-reported
  // "everything flashing like mad except the name" — the name is in
  // the stub HTML so it survives the wipe; everything else (price,
  // change, sparkline, star, MED pill, CLOSED badge) lives only in
  // the hydrated body and gets re-rendered.
  //
  // The diff captures the small slices of state that actually change
  // grid output. Anything else (settings, coach state, holdings on a
  // different page) is ignored — render() doesn't fire.
  let _lastWlSig = getState().watchlist.join(",");
  let _lastUserSig = getState().user?.id || "";
  // CRITICAL: init format MUST match the comparison format below
  // (line 271: Object.keys(...).sort().join(",")). Pre-fix this was
  // JSON.stringify(holdings) â€” which always differs from the
  // sorted-keys join, so the first state emit (which fires shortly
  // after mount when state.js does its Supabase session resume +
  // cross-tab storage sync) always saw a fake "holdings changed"
  // signal and triggered render() â€” wiping the hydrated grid for
  // a no-op state change. User-reported residual blink after
  // Hotfix22+23 ('cards still blink once before stabilizing').
  let _lastHoldingsSig = Object.keys(getState().holdings || {}).sort().join(",");
  const unsub = subscribe((state) => {
    if (cancelled) return;
    const wlSig = state.watchlist.join(",");
    const userSig = state.user?.id || "";
    // Only stringify holdings keys (symbol list) — full holdings JSON would
    // re-render on every avg-cost recompute. Watchlist needs symbol-set
    // diffing; holdings only matters for "you hold" badges on the cards.
    const holdingsSig = Object.keys(state.holdings || {}).sort().join(",");
    if (wlSig !== _lastWlSig || userSig !== _lastUserSig || holdingsSig !== _lastHoldingsSig) {
      _lastWlSig = wlSig;
      _lastUserSig = userSig;
      _lastHoldingsSig = holdingsSig;
      // wasReady guard. Same pattern as Hotfix23. The Supabase async
      // session-resume completes ~1-3 s after mount â€” often AFTER the
      // mood-banner fail-open at 2 s already flipped pageReady to
      // true. When auth resume lands, watchlist/holdings sigs change
      // legitimately and a render() here would wipe every hydrated
      // card. The watchlist-star + holdings-badge updates won't
      // surface until the next genuine re-render (filter/sort/search
      // change, watchlist toggle on a different page) â€” minor stale-
      // decoration tradeoff vs. the visible grid blink. Same
      // tradeoff we already accepted for the mood banner + MF count.
      if (pageReady()) return;
      render();
    }
  });
  // Full universe lands asynchronously — re-render when the loader fires so
  // the instrument count pill and "All NSE" source both pick up Tier 2.
  // Fetch quotes for the top N symbols of the post-universeFull sort
  // order so when the skeleton drops, the visible viewport already has
  // real prices. 60 covers ~24 visible cards × 2.5x scroll buffer. The
  // 3-second timeout ensures a slow upstream API doesn't hold the
  // skeleton indefinitely (fail-open: drop skeleton, prices fill in
  // via warm-up-from-observer as before, just with the visible
  // staircase the user reported — better than infinite skeleton).
  let _viewportPreheatTimer = null;
  function kickViewportPreheat() {
    if (_viewportPreheatDone || cancelled) return;
    const state = getState();
    const top = applyFilters(source(), filter, state, quoteCache).slice(0, VIEWPORT_PREHEAT_SIZE);
    // Hotfix27c: filter seed to MISSES from quoteCache. Mirror of
    // Hotfix22a's same-shape fix on the warm-up-from-observer batch.
    // Pre-fix the preheat always fired a getQuoteBatch round-trip even
    // when every visible-viewport symbol was already in cache (typical
    // on a warm visit â€” getFreshCachedQuotes at line ~196 fills the
    // cache synchronously from localStorage). After this commit warm
    // loads with full cache coverage send seed=[] and short-circuit
    // straight to _viewportPreheatDone=true + render() within ~10 ms
    // of mount. pageReady flips on the same tick. Visible cards paint
    // before the next frame.
    const seed = top.filter(i => i.kind !== KIND_MF && !quoteCache[i.symbol]?.pricePaise).map(i => i.symbol);
    if (seed.length === 0) {
      // Hotfix42: ALSO flip _initialQuotesLoaded. When Hotfix27b skipped
      // the cold-start IIFE on warm-cache loads, _initialQuotesLoaded
      // would only get set by the line 215 fresh-cache pre-flag â€” which
      // requires localStorage to have â‰¥5 quotes already. On a fresh
      // profile arriving at /stocks via another page (Portfolio â†’ Markets),
      // that pre-flag misses and the preheat fast-path here never sets
      // _initialQuotesLoaded â€” pageReady stays false forever, skeleton
      // sticks. Now the no-network path flips both flags symmetrically.
      _viewportPreheatDone = true;
      _initialQuotesLoaded = true;
      render();
      return;
    }
    if (_viewportPreheatTimer) clearTimeout(_viewportPreheatTimer);
    _viewportPreheatTimer = setTimeout(() => {
      if (!cancelled && !_viewportPreheatDone) {
        // Same fix on the fail-open path â€” if preheat hangs and timer
        // fires, we still need _initialQuotesLoaded to flip so pageReady
        // can return true.
        _viewportPreheatDone = true;
        _initialQuotesLoaded = true;
        render();
      }
    }, PREHEAT_FAIL_OPEN_MS);
    getQuoteBatch(seed).then(q => {
      if (cancelled) return;
      quoteCache = { ...quoteCache, ...q };
      // Capture readiness BEFORE flipping _viewportPreheatDone — if the
      // fail-open timer beat us to it, the page is already showing the
      // hydrated grid and a render() here would wipe every card.
      const wasReady = pageReady();
      _viewportPreheatDone = true;
      // Hotfix42: same flag-symmetry fix on the success path. Preheat
      // populating quoteCache is sufficient evidence quotes are loaded.
      _initialQuotesLoaded = true;
      if (_viewportPreheatTimer) { clearTimeout(_viewportPreheatTimer); _viewportPreheatTimer = null; }
      if (wasReady) {
        // Timer fired first. Page already rendered. Patch in the fresh
        // quotes (fp-aware — no DOM rewrite when fingerprints match)
        // instead of re-rendering and wiping the grid.
        patchHydratedCards(q);
      } else {
        render();
      }
    }).catch(() => {
      // fail-open — timer fallback handles this
    });
  }
  // Already-loaded path: if universeFull was loaded by another page or
  // earlier this session, the ss:universe-loaded event won't fire for
  // this mount. Kick the preheat immediately in that case.
  if (_universeLoaded) kickViewportPreheat();
  const onUniverseLoaded = () => {
    if (cancelled) return;
    // Same wasReady guard as the cold-start + preheat callbacks. If
    // _universeLoaded was already true (pre-flagged at mount because
    // INSTRUMENTS already had the full universe from a prior page),
    // the page may already be showing hydrated cards — a render()
    // here would wipe them. Skip the render in that case.
    const wasReady = pageReady();
    _universeLoaded = true;
    if (!wasReady) render();
    kickViewportPreheat();
  };
  window.addEventListener("ss:universe-loaded", onUniverseLoaded);
  const onLeave = () => {
    cancelled = true;
    unsub?.();
    pollUnsub?.();
    window.removeEventListener("ss:universe-loaded", onUniverseLoaded);
    window.removeEventListener("ss:mf-universe-loaded", onMfLoaded);
    if (aiSearchAbort) { try { aiSearchAbort.abort(); } catch {} aiSearchAbort = null; }
    if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
    if (_cardObserver) { try { _cardObserver.disconnect(); } catch {} _cardObserver = null; }
    if (_dehydrateObserver) { try { _dehydrateObserver.disconnect(); } catch {} _dehydrateObserver = null; }
    _visibleSymbols.clear();
  };
  window.addEventListener("hashchange", onLeave, { once: true });

  // Viewport-only polling. At 2,700+ universe symbols, polling all of them
  // every 10s would burn the Vercel function budget AND saturate Yahoo's
  // rate limits AND uselessly fetch quotes for cards the user can't see.
  // The visible-symbols Set is populated by an IntersectionObserver wired
  // in renderList() / render() (see attachCardObserver below). The poll
  // callback reads the snapshot each tick. On cold load (before any card
  // has rendered) we seed with the top-30 by idx prominence so users see
  // real prices on the first row of cards immediately.
  _visibleSymbols = new Set();
  function symbolsToPoll() {
    if (_visibleSymbols.size > 0) {
      // Only poll EQUITY/ETF symbols — MFs have no real-time feed.
      return Array.from(_visibleSymbols).filter(s => {
        const inst = getInstrument(s);
        return !inst || inst.kind !== KIND_MF;
      });
    }
    // Cold-start seed: top-30 by index prominence in the current source view.
    const state = getState();
    const list = applyFilters(source(), filter, state, quoteCache).slice(0, COLD_START_SEED);
    return list.filter(i => i.kind !== KIND_MF).map(i => i.symbol);
  }

  (async () => {
    try {
      // Hotfix27b: skip the cold-start IIFE entirely when the universe
      // is already loaded at mount. In that case Hotfix21b's preheat
      // (kicked synchronously at line ~287 via the `if (_universeLoaded)
      // kickViewportPreheat()` branch) covers a SUPERSET of what the
      // cold-start would fetch (top 60 vs top 30, same sort order).
      // Running both means a redundant network round-trip for 30
      // overlapping symbols. Saves ~200-500 ms on warm loads (any
      // visit after the first session-mount of /stocks). Cold loads
      // (universe not in cache) still need this IIFE because the
      // preheat blocks on universeFull while cold-start uses the
      // smaller curated.js fallback â€” cold-start lands first there.
      if (_universeLoaded) return;
      const seed = symbolsToPoll();
      if (!seed.length) return;
      const q = await getQuoteBatch(seed);
      if (cancelled) return;
      quoteCache = { ...quoteCache, ...q };
      // Mark first-batch ready BEFORE rehydrating — the skeleton-vs-real
      // gate (Hotfix19c) re-checks readiness on every render, so flipping
      // this flag first means the next render() call below paints the
      // real grid instead of skeleton. Without this ordering, the gate
      // would still see _initialQuotesLoaded=false at render time even
      // though the quotes are already in quoteCache.
      // Capture readiness BEFORE flipping _initialQuotesLoaded — if the
      // page was already hydrated (Hotfix21b's preheat finished first
      // and rendered the real grid), a render() here would wipe every
      // card back to a stub. User-reported regression after Hotfix22:
      // 'cards load, go skeleton, blink within 300ms, stable'. Skip
      // the wipe and just patch the new quotes into the live DOM.
      const wasReady = pageReady();
      _initialQuotesLoaded = true;
      if (wasReady) {
        // Page is already showing fully-hydrated cards. Patch the new
        // quotes into existing DOM nodes (fp-aware — skips when data
        // unchanged). No render(), no wipe, no blink.
        patchHydratedCards(q);
      } else {
        // Skeleton is still up. Hydrate cards that already exist (rare
        // — usually the grid hasn't been emitted yet) and trigger the
        // skeleton → real grid swap.
        rehydrateCardsInPlace(Object.keys(q));
        render();
      }
    } catch {}
  })();

  pollUnsub = subscribeToQuotes(symbolsToPoll, (quotes) => {
    if (cancelled) return;
    quoteCache = { ...quoteCache, ...quotes };
    // Quote-tick update — patch hydrated cards in place instead of doing a
    // full innerHTML rewrite. The full-rewrite path was wiping the grid
    // every 10 s, dropping the IntersectionObserver bindings, re-emitting
    // stubs, and causing on-screen cards to flash skeleton→hydrated on every
    // tick. patchHydratedCards mutates the live DOM nodes directly: only
    // the price text node, change classlist+text+badge, and sparkline SVG
    // get touched. ~5 ms vs ~80–300 ms for the old path.
    //
    // Exception: when sort=gainers/losers the order depends on live data,
    // so we still need a full re-list to reflect rank changes.
    patchHydratedCards(quotes);
    if (filter.sort === "gainers" || filter.sort === "losers") {
      renderList();
    }
    if (!marketMood && !_moodFetched && Object.keys(quoteCache).length > MOOD_FETCH_QUOTE_THRESHOLD) {
      _moodFetched = true;
      fetchMarketMood().then((m) => {
        if (cancelled) return;
        // Hotfix59a: when the LLM fetch fails OR returns no narrative,
        // hide the skeleton instead of leaving a forever-shimmer. We
        // collapse the slot to empty so the layout shifts back closed.
        const slot = main.querySelector("#market-mood-slot");
        if (!m || !m.narrative) {
          if (slot) slot.innerHTML = "";
          return;
        }
        marketMood = m;
        _moodReady = true;
        // Hotfix27a: surgical DOM update of the mood slot instead of
        // render(). Mood is no longer a pageReady gate, so the page is
        // typically already showing hydrated cards by the time this
        // resolves — a render() here would wipe them. Find the slot
        // div emitted at line ~761 and replace its innerHTML with
        // the mood card markup.
        if (slot) slot.innerHTML = renderMoodHtml(m);
      }).catch(() => {
        // Same fallback as above — drop the skeleton on network error.
        const slot = main.querySelector("#market-mood-slot");
        if (slot) slot.innerHTML = "";
      });
    }
  }, QUOTE_POLL_INTERVAL_MS);

  // Patch the price/change/sparkline of hydrated cards in place. Stub cards
  // (not yet scrolled into view) skip — they'll pick up the fresh quote when
  // they hydrate via the IntersectionObserver. CSS.escape handles symbols
  // with `&` (M&M) or `-` (BAJAJ-AUTO) safely.
  function patchHydratedCards(quotes) {
    const host = main.querySelector("#stocks-grid-host");
    if (!host) return;
    const ms = marketStatus();
    for (const sym of Object.keys(quotes)) {
      // Find ANY card for this symbol (stub OR hydrated). Pre-Hotfix26
      // the selector filtered to [data-rendered="1"], which skipped
      // stubs entirely â€” so when the warm-up batch returned quotes
      // for stub cards (typical after Hotfix21c made stubs stay
      // stubs until quotes arrive), patchHydratedCards silently
      // dropped them at the querySelector and the cards stayed
      // skeleton forever. User-reported: 'been staring for two
      // minutes' on R-prefixed stocks deep in the alphabetical scroll.
      // The skeleton-state guard at line ~510 (if !priceEl â†’
      // rehydrateCardsInPlace) is what actually transforms a stub
      // â†’ hydrated â€” we just had to STOP filtering it out before
      // reaching the guard.
      const sel = `.stock-card[data-sym="${CSS.escape(sym)}"]`;
      const card = host.querySelector(sel);
      if (!card) continue;
      const q = quotes[sym];
      // Detect "card was hydrated as skeleton" — i.e., it has no .stock-price
      // element because hasLive was false at hydration time. patchHydratedCards
      // can't fill in just the price text on such a card; the layout structure
      // is different (skeleton div, not .stock-price + .stock-change). The
      // user-visible bug pre-fix: card showed change% + LIVE badge but NO
      // price (top-row cards in the OBS screenshot). Recovery path: re-render
      // the whole card body in place via rehydrateCardsInPlace, which uses
      // the now-populated quoteCache to emit the correct hasLive=true layout.
      const priceEl = card.querySelector(".stock-price");
      // Skeleton-state guard: if the card is missing .stock-price it was
      // hydrated with hasLive=false (skeleton-shaped body). Two cases:
      //  - We have a price now → re-render the body in place via the
      //    hasLive=true path. rehydrateCardsInPlace replaces the whole
      //    card.innerHTML so the change line + sparkline come along
      //    correctly, no need to fall through.
      //  - We still don't have a price → leave the skeleton as-is. Do NOT
      //    fall through to the change/sparkline updates below; writing
      //    just the change line on a card with no price slot reproduces
      //    the OBS-screenshot bug ("change% + LIVE badge but no price").
      // Invariant after this guard: patchHydratedCards only mutates
      // fully-hydrated cards. Any future quote-source change that emits
      // changePct without pricePaise can't reintroduce the half-broken
      // render.
      if (!priceEl) {
        if (q.pricePaise != null) rehydrateCardsInPlace([sym]);
        continue;
      }
      if (q.pricePaise != null) {
        priceEl.textContent = formatRupees(q.pricePaise);
      }
      const changeEl = card.querySelector(".stock-change");
      if (changeEl && q.changePct != null) {
        // Fingerprint-guarded write — same pattern as the sparkline fix
        // below. Outside market hours getCloses returns identical seeded
        // data, so this skip is hit on >99% of poll ticks.
        //
        // Badge logic now respects market status: CLOSED/PRE-OPEN take
        // precedence over LIVE/DELAYED. Pre-fix patchHydratedCards
        // unconditionally stamped LIVE/DELAYED, overwriting the correct
        // CLOSED badge that had been placed at hydration time. Visible
        // bug in the OBS screenshot: "LIVE" pills displayed on every
        // card while the navbar showed "NSE · Closed 6:29 PM IST".
        const newClass = `stock-change ${deltaClass(q.changePct)}`;
        const fp = computeChangeFp(q.changePct, q.source, q.stale, ms.state);
        if (changeEl.dataset.changeFp !== fp) {
          changeEl.dataset.changeFp = fp;
          changeEl.className = newClass;
          let badge;
          if (ms.state !== "open") {
            const lbl = ms.state === "pre-open" ? "PRE-OPEN" : "CLOSED";
            badge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);">${lbl}</span>`;
          } else if (q.source && q.source !== "mf-static" && q.source !== "synthetic") {
            badge = q.stale
              ? _stalenessBadge(q, getInstrument(sym))
              : `<span class="pill pill-green" style="font-size: 9px; padding: 1px 6px;" title="NSE · Live">LIVE</span>`;
          } else {
            badge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Live feed syncing">SYNCING</span>`;
          }
          changeEl.innerHTML = `${formatPct(q.changePct, { sign: true })} today ${badge}`;
        }
      }
      const sparkEl = card.querySelector(".stock-sparkline");
      if (sparkEl) {
        const seededCloses = getCloses(sym, SPARKLINE_SEED_LENGTH);
        const closes = getIntradaySparkline(sym, seededCloses);
        if (closes && closes.length > 1) {
          // Fingerprint-guarded write: cheap length+last-value check skips
          // the innerHTML rewrite when the sparkline data hasn't changed.
          // Pre-fix this ran unconditionally every 10s for every visible
          // card, tearing down + rebuilding the SVG DOM subtree even when
          // closes was byte-identical to last tick. Result: every card
          // visibly re-painted on every quote tick — user-reported as
          // "cards near the top keep flashing/blinking like mad". Outside
          // market hours getCloses returns identical seeded data, so this
          // skip is hit on >99% of poll ticks.
          const fp = `${closes.length}:${closes[closes.length - 1]}`;
          if (sparkEl.dataset.sparkFp !== fp) {
            sparkEl.dataset.sparkFp = fp;
            sparkEl.innerHTML = sparkline(closes);
          }
        }
      }
    }
  }

  // Re-render the inner body of specific cards in place, without wiping
  // the grid. Used when the warm-up batch (initial mount + IO first-fire)
  // returns quotes for cards that were already hydrated in skeleton state
  // (because quoteCache was empty at hydration time). Replacing card.innerHTML
  // preserves the outer wrapper — IO observations stay intact, scroll
  // position is preserved, no chain-reaction of re-hydrations.
  //
  // Pre-fix: warm-up callbacks called renderList() which wiped #stocks-grid-host
  // entirely. That re-emitted all stubs, re-attached observers, fired IO
  // for visible cards which hydrated them again, then quote tick patched.
  // ~5 round-trips per cycle, ~5x re-hydrations per visible card during
  // scroll = continuous user-visible flashing + scroll position resets.
  function rehydrateCardsInPlace(syms) {
    if (!Array.isArray(syms) || !syms.length) return;
    const host = main.querySelector("#stocks-grid-host");
    if (!host) return;
    const state = getState();
    const wlSet = new Set(state.watchlist);
    const ms = marketStatus();
    for (const sym of syms) {
      if (!sym) continue;
      const card = host.querySelector(`.stock-card[data-sym="${CSS.escape(sym)}"]`);
      if (!card) continue;
      const inst = getInstrument(sym);
      if (!inst) continue;
      const seededCloses = getCloses(sym, SPARKLINE_SEED_LENGTH);
      const closes = getIntradaySparkline(sym, seededCloses);
      const quote = quoteCache[sym];
      const hasLive = quote?.pricePaise != null;
      const navFallbackPaise = (inst.kind === KIND_MF && typeof inst.nav === "number" && inst.nav > 0)
        ? Math.round(inst.nav * 100)
        : null;
      const price = hasLive ? quote.pricePaise : navFallbackPaise;
      const change = quote?.changePct ?? getTodayChange(sym);
      const isWatched = wlSet.has(sym);
      let liveBadge;
      if (inst.kind === KIND_MF) {
        liveBadge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Mutual Fund NAV">NAV</span>`;
      } else if (ms.state !== "open") {
        const lbl = ms.state === "pre-open" ? "PRE-OPEN" : "CLOSED";
        liveBadge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);">${lbl}</span>`;
      } else if (quote?.source && quote.source !== "mf-static" && quote.source !== "synthetic") {
        liveBadge = quote.stale
          ? _stalenessBadge(quote, inst)
          : `<span class="pill pill-green" style="font-size: 9px; padding: 1px 6px;" title="NSE · Live">LIVE</span>`;
      } else {
        liveBadge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Live feed syncing">SYNCING</span>`;
      }
      // Pre-compute the change-line fingerprint so the first quote-tick
      // after this rehydrate is a fingerprint hit in patchHydratedCards
      // (no innerHTML rebuild on identical content). Mirrors data-spark-fp.
      const changeFp = inst.kind === KIND_MF ? null : computeChangeFp(change, quote?.source, quote?.stale, ms.state);
      card.innerHTML = renderStockBodyForView(inst, state, wlSet, {
        closes, hasLive, price, change, isWatched, liveBadge, changeFp,
      }, viewMode);
      card.dataset.stub = "";
      card.dataset.rendered = "1";
      card.classList.remove("stock-card-stub");
    }
  }

  // Site-wide skeleton state shown during the brief window between page
  // mount and universeFull.json arriving. Replaces the previous behaviour
  // where the page would flash 116 featured stocks first then re-render
  // with the full 16,655-instrument universe. Skeleton is more honest:
  // "we're loading" instead of "here's a different page that's about to
  // change". Re-renders to the real layout once `ss:universe-loaded`
  // fires (already wired via the existing onUniverseLoaded listener).
  function renderSkeletonState() {
    const skelCard = `<div class="stock-card stock-card-stub" style="min-height: 172px; pointer-events: none;">
      <div class="stock-head">
        <div class="stock-avatar skeleton" style="width: 32px; height: 32px;"></div>
        <div class="stock-title">
          <div class="skeleton" style="width: 140px; height: 14px;"></div>
          <div class="skeleton" style="width: 80px; height: 10px; margin-top: 6px;"></div>
        </div>
      </div>
      <div class="skeleton" style="width: 96px; height: 20px; margin-top: 8px;"></div>
      <div class="skeleton" style="width: 70px; height: 12px; margin-top: 6px;"></div>
      <div class="skeleton" style="width: 100%; height: 40px; margin-top: 8px;"></div>
    </div>`;
    const skelPill = (w) => `<span class="filter-pill skeleton" style="width: ${w}px; height: 32px; display: inline-block; border-radius: 16px;"></span>`;
    const skelSectorPill = (w) => `<span class="filter-pill skeleton" style="width: ${w}px; height: 28px; display: inline-block; border-radius: 14px;"></span>`;
    main.innerHTML = `
      <div class="flex items-start justify-between wrap gap-3" style="margin-bottom: var(--sp-4);">
        <div>
          <h1>Markets</h1>
          <p class="muted"><span class="skeleton" style="width: 240px; height: 14px; display: inline-block; vertical-align: middle;"></span></p>
        </div>
        <span class="data-badge"><span class="dot offline"></span> Loading…</span>
      </div>
      <div class="stocks-toolbar">
        <div class="input-prefix">
          <span class="px">🔍</span>
          <input type="search" placeholder="Loading markets…" disabled style="opacity: 0.6;" />
        </div>
        <span class="skeleton" style="width: 110px; height: 32px; border-radius: 8px; display: inline-block;"></span>
        <span class="skeleton" style="width: 200px; height: 38px; border-radius: 8px; display: inline-block;"></span>
      </div>
      <div class="filter-pills" style="margin-bottom: var(--sp-3);">
        ${[100, 70, 130, 110].map(skelPill).join("")}
      </div>
      <div class="filter-pills" style="margin-bottom: var(--sp-5); max-height: 88px; overflow-y: hidden;">
        ${[80, 60, 90, 75, 100, 65, 85, 70, 95, 80, 105, 70].map(skelSectorPill).join("")}
      </div>
      <div class="stocks-grid stocks-grid--${viewMode}">
        ${Array(12).fill(skelCard).join("")}
      </div>
    `;
  }

  // Single source of truth for "is the grid currently showing hydrated cards
  // (vs. the loading skeleton)?" Used by render() to choose between
  // renderSkeletonState() and the full grid emit, AND by every
  // late-resolving callback that calls render() to decide whether
  // to skip a redundant render that would wipe hydrated cards.
  function pageReady() {
    // _moodReady removed from the gate as of Hotfix27a. The mood banner
    // is decorative â€” there's no reason to hold the entire grid behind a
    // 2-second LLM call. The banner now renders into a slot div with
    // empty initial content; when the mood fetch resolves it surgically
    // replaces the slot's innerHTML without firing render(). Net cold-
    // load improvement: ~1.5 s in the typical case where mood is the
    // slowest gate to flip.
    return _universeLoaded && _initialQuotesLoaded && _viewportPreheatDone;
  }

  function render() {
    const state = getState();
    const wlSet = new Set(state.watchlist);
    const allInst = getAllInstruments();
    // Use the boolean tracked at function scope (set true by onUniverseLoaded
    // event listener OR pre-flagged at mount when allInst > 1000 already).
    // The previous `allInst.length > STOCKS.length` heuristic was off by 10
    // because curated.js's PLACEHOLDER_MFS still get included in allInst at
    // pre-universeFull state.
    const universeReady = _universeLoaded;
    // Page is "real-grid ready" only when ALL of (a) the full universe has
    // landed (b) the cold-start quote batch has resolved (c) the viewport
    // preheat (Hotfix21b) has resolved or failed-open (d) the mood banner
    // is ready or failed-open. Collapses several intermediate frames into
    // a single skeleton state — the page either shows skeleton (waiting)
    // or shows fully-priced cards (ready).
    const isReady = pageReady();

    // Pre-universe-loaded: emit a full-page skeleton instead of the
    // 116-featured "real" view that briefly flashed in pre-Hotfix12. The
    // user-visible delta was confusing — the page would render with
    // ACC/ADANIENT/ADANIGREEN... for ~1 s, then re-render with the full
    // 16,655-instrument universe. Skeleton state is more honest about
    // "we're still loading" and matches the design language users
    // already see on stub cards.
    if (!isReady) {
      renderSkeletonState();
      return;
    }

    const fullList = applyFilters(source(), filter, state, quoteCache);
    const list = fullList.slice(0, visibleCount);
    const truncated = fullList.length > list.length;
    const src = getDataSource();
    // Hotfix63a: replaced raw NSE-derived sectors (30 fragmentary
    // buckets — Energy, NBFC, Services, Other, Conglomerate,
    // Internet, Fintech, Exchange, etc.) with Groww-aligned canonical
    // categories. Each entry carries a count so the pill row reads
    // like Groww's: 'Banking 42', 'Oil & Gas 37', 'IT 186', etc.
    const canonicalCats = getCanonicalCategoryCounts();
    const totalEquityForPills = canonicalCats.reduce((s, c) => s + c.count, 0);
    // Tab counts — derived from the full universe (all kinds), not the
    // filtered list. Shows "..." until Tier-2 lands.
    const equityCount = universeReady ? allInst.filter(i => i.kind === KIND_EQUITY).length : null;
    const etfCount    = universeReady ? allInst.filter(i => i.kind === KIND_ETF).length : null;
    // Hotfix46c: show ACTIVE MF count, not the raw 13,969 figure that
    // includes ~5,000 zombie schemes. The headline number now
    // reflects what the user actually sees in the grid below.
    const mfCount     = universeReady ? allInst.filter(i => i.kind === KIND_MF && !_isMfTerminated(i)).length : null;
    // Preserve focus + caret on the search input across the re-render — every
    // keystroke triggers this render and the 10s live-quote poll does too, so
    // without this the user can't type more than one character at a time.
    const active = document.activeElement;
    const restore = active && active.id === "stocks-search" ? {
      start: active.selectionStart,
      end: active.selectionEnd,
    } : null;
    main.innerHTML = `
      <div class="flex items-start justify-between wrap gap-3" style="margin-bottom: var(--sp-4);">
        <div>
          <h1>Markets</h1>
          <p class="muted">${(() => {
            // Hotfix61a: total = sum of the visible breakdown counts,
            // not allInst.length. Raw rows include 5,000+ wound-up
            // zombie MFs we hide via _isMfTerminated, so the prior
            // "16,665 instruments · ... · 8,741 mutual funds" headline
            // didn't add up. Now total = stocks + ETFs + active MFs,
            // matching what the user can actually browse below.
            const equityCt = allInst.filter(i => i.kind === KIND_EQUITY).length;
            const etfCt    = allInst.filter(i => i.kind === KIND_ETF).length;
            const mfActive = allInst.filter(i => i.kind === KIND_MF && !_isMfTerminated(i)).length;
            const total    = equityCt + etfCt + mfActive;
            const fmt = (n) => n.toLocaleString("en-IN");
            const parts = [`${fmt(total)} instruments`];
            if (equityCt) parts.push(`${fmt(equityCt)} stocks`);
            if (etfCt)    parts.push(`${fmt(etfCt)} ETFs`);
            if (mfActive) parts.push(`${fmt(mfActive)} mutual funds`);
            return parts.join(" · ");   // U+00B7 middle dot (clean UTF-8)
          })()}</p>
        </div>
        <span class="data-badge"><span class="dot"></span> ${escapeHtml(src.name)}</span>
      </div>

      <div id="market-mood-slot">${renderMoodHtml(marketMood)}</div>

      ${aiSearch ? `
        <div class="ai-search-result-card">
          <div class="flex items-center gap-2" style="margin-bottom: 6px;">
            <span class="pf-digest-label">Saathi filter</span>
            <span class="dim text-xs">"${escapeHtml(aiSearchQuery)}" · ${aiSearch.matches.length} matches</span>
            <button class="btn btn-ghost btn-sm" id="ai-search-clear" style="margin-left:auto;">✕ Clear</button>
          </div>
          ${aiSearch.rationale ? `<div class="muted text-sm" style="margin-bottom: 8px;">${escapeHtml(aiSearch.rationale)}</div>` : ""}
        </div>
      ` : ""}

      <div class="stocks-toolbar">
        <div class="input-prefix">
          <span class="px">🔍</span>
          <input type="search" id="stocks-search" placeholder="Search, or try &quot;cheap IT stocks with low debt&quot;..." value="${escapeAttr(filter.q)}" />
        </div>
        <button class="btn btn-ghost btn-sm" id="ask-saathi-btn" title="Filter the universe with natural language" ${aiSearchLoading ? "disabled" : ""}>${aiSearchLoading ? "…" : "✨ Ask Saathi"}</button>
        <div id="stocks-sort" style="min-width: 200px;"></div>
        <div class="view-toggle" role="tablist" aria-label="View mode" title="Switch list density">
          <button class="view-toggle-btn ${viewMode === "tiles" ? "active" : ""}" data-view="tiles" role="tab" aria-selected="${viewMode === "tiles"}" title="Compact list (Groww-style)">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="2" width="14" height="2.4" rx="1" fill="currentColor"/><rect x="1" y="6.8" width="14" height="2.4" rx="1" fill="currentColor"/><rect x="1" y="11.6" width="14" height="2.4" rx="1" fill="currentColor"/></svg>
            <span class="view-label">Tiles</span>
          </button>
          <button class="view-toggle-btn ${viewMode === "cards" ? "active" : ""}" data-view="cards" role="tab" aria-selected="${viewMode === "cards"}" title="Detailed cards with sparkline">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="1" width="6.5" height="6.5" rx="1.2" fill="currentColor"/><rect x="8.5" y="1" width="6.5" height="6.5" rx="1.2" fill="currentColor"/><rect x="1" y="8.5" width="6.5" height="6.5" rx="1.2" fill="currentColor"/><rect x="8.5" y="8.5" width="6.5" height="6.5" rx="1.2" fill="currentColor"/></svg>
            <span class="view-label">Cards</span>
          </button>
        </div>
      </div>

      <div class="filter-pills" style="margin-bottom: var(--sp-3);">
        <button class="filter-pill ${filter.kind === KIND_EQUITY ? "active" : ""}" data-kind="EQUITY">Stocks${equityCount ? ` (${equityCount})` : ""}</button>
        <button class="filter-pill ${filter.kind === KIND_ETF ? "active" : ""}" data-kind="ETF">ETFs${etfCount ? ` (${etfCount})` : ""}</button>
        <button class="filter-pill ${filter.kind === KIND_MF ? "active" : ""}" data-kind="MF">Mutual Funds${mfCount ? ` (${mfCount})` : ""}</button>
        <button class="filter-pill ${filter.kind === "watchlist" ? "active" : ""}" data-kind="watchlist">★ Watchlist (${state.watchlist.length})</button>
      </div>
      ${filter.kind === KIND_MF ? `
        <div class="filter-pills" style="margin-bottom: var(--sp-3); max-height: 88px; overflow-y: auto;">
          <button class="filter-pill ${filter.mfBucket === "all" ? "active" : ""}" data-mfbucket="all">All categories</button>
          ${getMfCategoryBuckets().map(b => `<button class="filter-pill ${filter.mfBucket === b ? "active" : ""}" data-mfbucket="${escapeAttr(b)}">${escapeHtml(b)}</button>`).join("")}
        </div>
        <div class="filter-pills" style="margin-bottom: var(--sp-5);">
          <button class="filter-pill ${filter.mfPlan === "all" ? "active" : ""}" data-mfplan="all">All plans</button>
          <button class="filter-pill ${filter.mfPlan === "Direct" ? "active" : ""}" data-mfplan="Direct" title="Direct plans have a lower expense ratio because no distributor commission is built in">Direct</button>
          <button class="filter-pill ${filter.mfPlan === "Regular" ? "active" : ""}" data-mfplan="Regular" title="Regular plans pay a distributor commission embedded in the expense ratio">Regular</button>
        </div>
      ` : filter.kind === KIND_ETF ? `
        <!-- ETF tab: equity-sector pills are useless here (every ETF row has
             sector="ETF", so any "Banking"/"Pharma"/etc. pill click yields 0
             results). Hide entirely. ETF category pills (Equity Index / Gold /
             Liquid / International) would need build-time enrichment that
             ships in a follow-up. -->
      ` : `
        <div class="filter-pills" style="margin-bottom: var(--sp-5); max-height: 88px; overflow-y: auto;">
          <button class="filter-pill ${filter.sector === "all" ? "active" : ""}" data-sector="all">All sectors${totalEquityForPills ? ` <span class="pill-count">${totalEquityForPills}</span>` : ""}</button>
          ${canonicalCats.map(c => `<button class="filter-pill ${filter.sector === c.name ? "active" : ""}" data-sector="${escapeAttr(c.name)}">${escapeHtml(c.name)} <span class="pill-count">${c.count}</span></button>`).join("")}
        </div>
      `}

      <div id="stocks-grid-host">${list.length === 0
        ? `<div class="empty-state"><span class="emoji">🔍</span><h3>No matches</h3><p>Try clearing a filter or searching differently.</p></div>`
        : `${viewMode === "tiles" ? _tileHeaderHtml() : ""}<div class="stocks-grid stocks-grid--${viewMode}">${list.map(inst => renderStubRow(inst, viewMode)).join("")}</div>${truncated ? `<div class="flex justify-center stocks-pager" style="margin-top: var(--sp-4); gap: 8px; flex-wrap: wrap;"><button class="btn btn-ghost" id="stocks-show-more">Show ${Math.min(PAGE_SIZE, fullList.length - list.length)} more (${fullList.length - list.length} remaining)</button><button class="btn btn-ghost" id="stocks-show-all">Show all ${fullList.length}</button></div>` : ""}`}</div>
    `;

    const searchEl = main.querySelector("#stocks-search");
    if (restore) {
      searchEl.focus();
      try { searchEl.setSelectionRange(restore.start, restore.end); } catch {}
    }
    searchEl.addEventListener("input", e => {
      const newQ = e.target.value;
      filter.q = newQ;
      visibleCount = PAGE_SIZE;   // reset pagination on new query
      // Hotfix46b: when the user clicks the input's built-in X (or
      // hits Backspace down to empty), also clear the AI search
      // result that may have been set from a prior 'Ask Saathi'
      // query. Without this clear, aiSearch overrides the keyword
      // filter inside applyFilters â€” user clears the box but the
      // AI-picked results stay on screen, only the explicit 'Clear'
      // button next to the rationale banner closes them. Confusing.
      if (newQ === "" && aiSearch) {
        aiSearch = null;
        aiSearchQuery = "";
      }
      // Hotfix43e: was render() which wipes main.innerHTML (header,
      // filter pills, sort dropdown, sector pills, AND grid) on every
      // keystroke. On mobile this caused user-reported 'typing lags
      // and duplicates, every character shakes the entire page, the
      // top-by-size list on the left shakes'. Switching to renderList()
      // touches ONLY the #stocks-grid-host innerHTML â€” surrounding
      // chrome (incl. the search input itself) is untouched, so:
      //   - input keeps focus + IME composition cleanly
      //   - filter/sort pills don't reflow
      //   - the search bar's own DOM node isn't being recreated under
      //     the user's cursor mid-keystroke (which was eating fast
      //     keystrokes and duplicating slow ones)
      // Bumped debounce 120 -> 180 ms to give renderList room on
      // 2,700-card universes; still under the 200 ms perceived-instant
      // threshold.
      if (_debounceTimer) clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(() => { if (!cancelled) renderList(); }, 180);
    });
    import("../components/themedSelect.js").then(({ mountThemedSelect }) => {
      mountThemedSelect(main.querySelector("#stocks-sort"), {
        value: filter.sort,
        options: [
          { value: "marketCap", label: "Top by size" },
          { value: "gainers",   label: "Top gainers today" },
          { value: "losers",    label: "Top losers today" },
          { value: "name",      label: "Name A–Z" },
        ],
        onChange: v => { filter.sort = v; visibleCount = PAGE_SIZE; render(); },
      });
    });
    main.querySelectorAll("[data-sector]").forEach(btn => btn.addEventListener("click", () => { filter.sector = btn.dataset.sector; visibleCount = PAGE_SIZE; render(); }));
    // Hotfix65a: view toggle (Tiles / Cards). renderList() rebuilds the
    // grid host with the new mode's stub HTML; the IO re-fires for
    // visible rows and hydrates them with renderStockTileBody (or
    // renderStockCardBody) per viewMode. Toolbar stays put — no full
    // render(). Hotfix65b: was a className-only flip, but tile + card
    // bodies are different HTML structures so the flip alone left
    // hydrated cards mismatched with the parent layout.
    main.querySelectorAll(".view-toggle-btn[data-view]").forEach(btn => btn.addEventListener("click", () => {
      const next = btn.dataset.view;
      if (next === viewMode) return;
      viewMode = next;
      saveViewMode(next);
      main.querySelectorAll(".view-toggle-btn").forEach(b => {
        const active = b.dataset.view === next;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", String(active));
      });
      visibleCount = PAGE_SIZE;   // collapse pagination on view switch
      renderList();
    }));
    main.querySelectorAll("[data-mfbucket]").forEach(btn => btn.addEventListener("click", () => { filter.mfBucket = btn.dataset.mfbucket; visibleCount = PAGE_SIZE; render(); }));
    main.querySelectorAll("[data-mfplan]").forEach(btn => btn.addEventListener("click", () => { filter.mfPlan = btn.dataset.mfplan; visibleCount = PAGE_SIZE; render(); }));
    main.querySelectorAll("[data-kind]").forEach(btn => btn.addEventListener("click", () => {
      filter.kind = btn.dataset.kind;
      filter.sector = "all";      // sector list changes between Stocks / ETFs / MFs / Watchlist
      visibleCount = PAGE_SIZE;
      // First click on Mutual Funds — kick the AMFI catalog fetch so the
      // grid populates with all ~14k schemes. Subsequent clicks are no-op
      // because ensureMfUniverseLoaded de-dupes via _mfLoadPromise.
      if (filter.kind === KIND_MF) ensureMfUniverseLoaded();
      render();
    }));
    // Show more / Show all rebuild only the grid (renderList) — no need to
    // tear down the toolbar + themed-select on every pagination click.
    main.querySelector("#stocks-show-more")?.addEventListener("click", () => { visibleCount += PAGE_SIZE; renderList(); });
    main.querySelector("#stocks-show-all")?.addEventListener("click", () => { visibleCount = 1e9; renderList(); });
    // Event delegation — ONE click listener on the grid host instead of
    // 2N listeners (card click + watchlist toggle) per card. At 2,364 stocks
    // this drops 4,728 listener attachments to 1, eliminating the 4-6 s
    // main-thread freeze "Show all" used to cause on mid-Android.
    attachGridDelegation(main.querySelector("#stocks-grid-host"));
    attachCardObserver(main.querySelector("#stocks-grid-host"));

    main.querySelector("#ask-saathi-btn")?.addEventListener("click", () => {
      const q = filter.q.trim();
      if (q.length < 3) {
        toast({ kind: "info", message: "Type a few words — e.g. 'IT stocks with low debt' — then hit Ask Saathi." });
        return;
      }
      runAiSearch(q, render);
    });
    main.querySelector("#ai-search-clear")?.addEventListener("click", () => {
      aiSearch = null;
      aiSearchQuery = "";
      render();
    });
    // Also trigger AI search on Enter inside the search input when the
    // query has multiple words (looks like natural language, not a ticker).
    searchEl.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        const q = filter.q.trim();
        if (q.split(/\s+/).length >= 2 && q.length >= 6) {
          e.preventDefault();
          runAiSearch(q, render);
        }
      }
    });
  }

  // Quote-tick path: rebuild ONLY the stocks grid. The toolbar (search
  // input, Top-by-size dropdown, filter pills) stays intact, so the
  // themed-select doesn't get torn down + re-mounted every 10 seconds
  // and the dropdown stops blinking.
  //
  // Chunked render: when visibleCount > CHUNK_THRESHOLD, we render the grid
  // in 200-stub batches with a requestAnimationFrame yield between batches.
  // Without this, "Show all 2,364" on Stocks held the main thread for ~10 s
  // (user-reported), and "Show all 13,969" on Mutual Funds triggered the
  // browser's "Tab not responding" warning. Each 200-stub batch parses in
  // ~20 ms and the RAF yield lets the browser paint what's there before the
  // next batch lands — user sees progressive fill instead of 10 s blank.
  const CHUNK_SIZE = 200;
  const CHUNK_THRESHOLD = 300;   // sub-300 lists render synchronously
  let _renderListSeq = 0;        // monotonic — cancels stale chunked renders
  async function renderList() {
    const mySeq = ++_renderListSeq;
    const state = getState();
    const wlSet = new Set(state.watchlist);
    const host = main.querySelector("#stocks-grid-host");
    if (!host) {
      // Shell not mounted yet — fall back to full render.
      render();
      return;
    }
    const fullList = applyFilters(source(), filter, state, quoteCache);
    const list = fullList.slice(0, visibleCount);
    const truncated = fullList.length > list.length;
    if (list.length === 0) {
      host.innerHTML = `<div class="empty-state"><span class="emoji">🔍</span><h3>No matches</h3><p>Try clearing a filter or searching differently.</p></div>`;
      attachGridDelegation(host);
      attachCardObserver(host);
      return;
    }
    // Build the pager footer string once — same for sync and chunked paths.
    const pagerHtml = truncated
      ? `<div class="flex justify-center stocks-pager" style="margin-top: var(--sp-4); gap: 8px; flex-wrap: wrap;">
          <button class="btn btn-ghost" id="stocks-show-more">Show ${Math.min(PAGE_SIZE, fullList.length - list.length)} more (${fullList.length - list.length} remaining)</button>
          <button class="btn btn-ghost" id="stocks-show-all">Show all ${fullList.length}</button>
        </div>`
      : "";

    const headerHtml = viewMode === "tiles" ? _tileHeaderHtml() : "";
    if (list.length <= CHUNK_THRESHOLD) {
      // Synchronous path — small lists render in one shot.
      host.innerHTML = `${headerHtml}<div class="stocks-grid stocks-grid--${viewMode}">${list.map(inst => renderStubRow(inst, viewMode)).join("")}</div>${pagerHtml}`;
      attachGridDelegation(host);
      attachCardObserver(host);
    } else {
      // Chunked path — render the first batch immediately so users see
      // SOMETHING within ~20 ms of clicking, then progressively fill.
      host.innerHTML = `${headerHtml}<div class="stocks-grid stocks-grid--${viewMode}"></div><div id="stocks-loading-indicator" class="dim text-xs center" style="margin: var(--sp-4) 0; padding: var(--sp-3);">Loading ${list.length.toLocaleString("en-IN")} stubs…</div>`;
      const grid = host.querySelector(".stocks-grid");
      // Wire the click delegation + create the IO once UP FRONT (with no
      // cards yet — observe-list starts empty). Then we incrementally
      // observe each chunk's cards as they're rendered. This is the key
      // ordering: if we called attachCardObserver at the END instead, it
      // would disconnect+recreate the IO and the cards in earlier chunks
      // would lose their observation between final render and final IO
      // setup, leaving them un-hydratable.
      attachGridDelegation(host);
      attachCardObserver(host);   // creates IO, observes nothing (grid empty)
      let rendered = 0;
      while (rendered < list.length) {
        // Bail out if a newer renderList() supersedes this one (e.g. user
        // changed sort/filter mid-render). Without this, two concurrent
        // chunked renders would interleave in the same grid.
        if (mySeq !== _renderListSeq || cancelled) return;
        const slice = list.slice(rendered, rendered + CHUNK_SIZE);
        const tmp = document.createElement("div");
        tmp.innerHTML = slice.map(inst => renderStubRow(inst, viewMode)).join("");
        const frag = document.createDocumentFragment();
        const newCards = [];
        while (tmp.firstChild) {
          newCards.push(tmp.firstChild);
          frag.appendChild(tmp.firstChild);
        }
        grid.appendChild(frag);
        // Observe the just-appended cards so the IO can hydrate them on
        // scroll-into-view even before the full render finishes. Both
        // observers (hydrate + dehydrate) need to see every card.
        for (const card of newCards) {
          if (card?.dataset?.sym) {
            try { _cardObserver?.observe(card); } catch {}
            try { _dehydrateObserver?.observe(card); } catch {}
          }
        }
        rendered += CHUNK_SIZE;
        // Yield to the browser. RAF runs once per frame (~16 ms at 60 Hz),
        // so each chunk gets a fresh frame to paint into. Total time for
        // 13,969 MFs is ~70 chunks × ~16 ms = ~1.1 s of progressive fill —
        // the user sees stubs appearing in waves instead of a frozen tab,
        // and Chrome no longer fires the "Tab not responding" popup.
        if (rendered < list.length) {
          await new Promise(r => requestAnimationFrame(r));
        }
      }
      // Remove the loading indicator and append the pager footer.
      host.querySelector("#stocks-loading-indicator")?.remove();
      if (pagerHtml) host.insertAdjacentHTML("beforeend", pagerHtml);
    }
    host.querySelector("#stocks-show-more")?.addEventListener("click", () => { visibleCount += PAGE_SIZE; renderList(); });
    host.querySelector("#stocks-show-all")?.addEventListener("click", () => { visibleCount = fullList.length; renderList(); });
  }

  // Viewport-aware observer. Drives both:
  //   1) Which symbols get polled by subscribeToQuotes (symbolsToPoll callback
  //      reads _visibleSymbols).
  //   2) Future virtualization hooks — the ratio crossing already maps onto
  //      "hydrate / dehydrate this card".
  // rootMargin "200% 0px 200% 0px" — pre-warms quotes for cards 2 viewport
  // heights above and below, so by the time the user scrolls them in, they
  // already have a live tick. Naturally responds to user resolution + zoom
  // (the browser computes intersection against the actual viewport box, not
  // a fixed pixel count).
  // threshold 0 — any pixel of the card visible within rootMargin counts.
  function attachCardObserver(host) {
    if (!host) return;
    // Tear down both observers — DOM nodes from the prior render are gone,
    // and disconnect() leaves the entry list dangling otherwise.
    if (_cardObserver) {
      try { _cardObserver.disconnect(); } catch {}
      _cardObserver = null;
    }
    if (_dehydrateObserver) {
      try { _dehydrateObserver.disconnect(); } catch {}
      _dehydrateObserver = null;
    }
    _visibleSymbols.clear();
    // Reset the one-shot warm-up flag — without this, every tab switch
    // (Stocks → ETFs → Mutual Funds → Watchlist) skips the immediate
    // first-paint getQuoteBatch and users wait the full 10s subscribeToQuotes
    // cycle for prices. Visible regression on prod: ETF cards stayed in the
    // skeleton-stuck state (gray bars where price should be) for 10s after
    // tab activation. Resetting here means the next IO callback's
    // !_warmedFromObserver branch fires fresh for the new viewport batch.
    _warmedFromObserver = false;
    if (typeof IntersectionObserver !== "function") {
      // Old browsers (or SSR test harness) — fall back to seeding all visible
      // symbols up front. The prefilter inside symbolsToPoll() then trims to
      // EQUITY/ETF only and the cold-start branch caps at 30.
      host.querySelectorAll(".stock-card[data-sym]").forEach(c => {
        if (c.dataset.sym) _visibleSymbols.add(c.dataset.sym);
      });
      return;
    }
    _cardObserver = new IntersectionObserver((entries) => {
      let changed = false;
      const state = getState();
      const wlSet = new Set(state.watchlist);
      for (const entry of entries) {
        const card = entry.target;
        const sym = card?.dataset?.sym;
        if (!sym) continue;
        if (entry.isIntersecting) {
          if (!_visibleSymbols.has(sym)) { _visibleSymbols.add(sym); changed = true; }
          // Hydrate the stub on first intersect. card.dataset.stub === "1"
          // means we're still showing the skeleton; swap in the full body.
          // Subsequent intersects (after un/re-intersect during scroll) skip
          // because dataset.stub has been cleared.
          if (card.dataset.stub === "1") {
            const inst = getInstrument(sym);
            if (inst) {
              // Defensive: if a non-MF card enters viewport without a
              // live quote in cache (covers the long tail beyond the
              // 21b viewport preheat — symbols user scrolls into after
              // the initial 60), skip the hydrate-as-skeleton path
              // entirely. The warm-up-from-observer batch fires below
              // when the IO callback's `changed` flag flips true; once
              // its quote arrives, rehydrateCardsInPlace renders this
              // card directly into the hasLive=true layout. Net user
              // experience: stub → fully-priced card in one transition,
              // never the intermediate "hydrated with skeleton price"
              // state. MFs short-circuit through this guard via
              // inst.nav fallback so they always hydrate immediately.
              const _q = quoteCache[sym];
              if (inst.kind !== KIND_MF && _q?.pricePaise == null) {
                continue;
              }
              const seededCloses = getCloses(sym, SPARKLINE_SEED_LENGTH);
              const closes = getIntradaySparkline(sym, seededCloses);
              const quote = _q;
              const hasLive = quote?.pricePaise != null;
              // MF NAV fallback (see same logic in renderStockCardBody) —
              // MFs never poll a live quote so the card body must read
              // inst.nav directly to show a real price.
              const navFallbackPaise = (inst.kind === KIND_MF && typeof inst.nav === "number" && inst.nav > 0)
                ? Math.round(inst.nav * 100)
                : null;
              const price = hasLive ? quote.pricePaise : navFallbackPaise;
              const change = quote?.changePct ?? getTodayChange(sym);
              const isWatched = wlSet.has(sym);
              const ms = marketStatus();
              let liveBadge;
              if (inst.kind === KIND_MF) {
                liveBadge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Mutual Fund NAV">NAV</span>`;
              } else if (ms.state !== "open") {
                const lbl = ms.state === "pre-open" ? "PRE-OPEN" : "CLOSED";
                liveBadge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);">${lbl}</span>`;
              } else if (quote?.source && quote.source !== "mf-static" && quote.source !== "synthetic") {
                liveBadge = quote.stale
                  ? _stalenessBadge(quote, inst)
                  : `<span class="pill pill-green" style="font-size: 9px; padding: 1px 6px;" title="NSE · Live">LIVE</span>`;
              } else {
                liveBadge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Live feed syncing">SYNCING</span>`;
              }
              // Pre-compute the change-line fingerprint for first-tick
              // no-op (mirrors data-spark-fp). MFs skip — patchHydratedCards
              // never patches MF change lines (MFs aren't in symbolsToPoll).
              const changeFp = inst.kind === KIND_MF ? null : computeChangeFp(change, quote?.source, quote?.stale, ms.state);
              card.innerHTML = renderStockBodyForView(inst, state, wlSet, {
                closes, hasLive, price, change, isWatched, liveBadge, changeFp,
              }, viewMode);
              card.dataset.stub = "";
              card.dataset.rendered = "1";
              card.classList.remove("stock-card-stub");
            }
          }
        } else {
          if (_visibleSymbols.has(sym)) { _visibleSymbols.delete(sym); changed = true; }
        }
      }
      // First-paint nudge: as soon as the initial entries fire, kick a quote
      // batch for whatever's actually on screen so the user sees real prices
      // within ~200ms instead of waiting for the 10s poll cycle.
      // Pre-Hotfix25 the gate was `&& !_warmedFromObserver` (one-shot).
      // That worked when the seed was unconditionally every visible
      // symbol, but Hotfix22a changed the seed to filter to misses-only,
      // which already short-circuits redundant fetches on scroll back
      // to cached regions. The one-shot flag became harmful: scrolling
      // into a new region with no cached quotes (e.g., far down into
      // the 'R*' alphabetical block) couldn't trigger another warm-up
      // batch because the flag was already set â€” cards stayed as
      // skeleton forever. User-reported: 'scrolling randomly to a
      // location the skeleton just keeps loading forever'.
      // Drop the flag from the gate. seed.length === 0 below already
      // skips the actual fetch when nothing's missing.
      if (changed && _visibleSymbols.size > 0) {
        _warmedFromObserver = true;  // kept for the attachCardObserver reset semantics
        // Only fetch symbols MISSING from quoteCache. Pre-fix the warm-up
        // batch always re-fetched every visible symbol, which after the
        // Hotfix21b viewport preheat meant a redundant round-trip for
        // 24-60 cards that already had fresh quotes — and the resulting
        // rehydrate produced a visible card-grid blink ~200 ms after
        // the page settled. User-reported: 'graph and prices on the
        // card again blink after the page loads'. Filtering to misses
        // skips the round-trip entirely when the preheat already
        // covers the viewport (typical case post-21b).
        const seed = Array.from(_visibleSymbols).filter(s => {
          const inst = getInstrument(s);
          if (inst?.kind === KIND_MF) return false;
          return !quoteCache[s]?.pricePaise;
        }).slice(0, VIEWPORT_PREHEAT_SIZE);
        if (seed.length) {
          getQuoteBatch(seed).then(q => {
            if (cancelled) return;
            quoteCache = { ...quoteCache, ...q };
            // patchHydratedCards is fingerprint-aware: cards whose price
            // and change-line haven't changed skip the innerHTML rewrite
            // entirely. Pre-fix this called rehydrateCardsInPlace which
            // unconditionally rebuilt every card's body — visible blink
            // ~200 ms after the page settled even when the data was
            // identical to what the preheat had already loaded.
            // patchHydratedCards detects skeleton-state cards (those
            // missing .stock-price after a stub-only emit) and falls
            // back to rehydrateCardsInPlace([sym]) for those, so cards
            // beyond the preheat still get their full hydrate path.
            patchHydratedCards(q);
          }).catch(() => {});
        }
      }
    }, {
      root: null,                     // viewport
      rootMargin: HYDRATE_ROOT_MARGIN,
      threshold: 0,
    });

    // Dehydrate observer — restores hydrated cards back to stubs when
    // they're at least 6 viewport heights past the visible region.
    //
    // Pre-Hotfix7 used `rootMargin: "-300% 0px -300% 0px"` thinking it
    // would shrink the root and use isIntersecting=false as the
    // "far away" signal. That math is broken: a viewport (height H)
    // shrunk by 300% top + 300% bottom = -5H = a NEGATIVE-sized
    // rectangle. Per the IO spec, every observed element reports
    // isIntersecting:false against a zero-or-negative-sized root.
    // Result: every card gets dehydrated immediately after hydration.
    //
    //   Stocks tab → top cards "kept flashing" (hydrate→dehydrate→
    //                hydrate cycle on every IO callback).
    //   ETFs / MFs → cards never escape the skeleton state because the
    //                buggy IO instant-dehydrates anything just hydrated.
    //
    // Correct semantics: use a LARGE POSITIVE rootMargin (600% on top
    // and bottom = 6 viewports of grace zone above + below) and the
    // SAME `!entry.isIntersecting` trigger. Now the root is HUGE — only
    // cards that fall OUTSIDE the wide zone (i.e., 6+ viewports past
    // the visible viewport) report isIntersecting=false. The grace
    // zone of 4 viewports between hydrate-margin (200%) and dehydrate-
    // margin (600%) means cards stay hydrated even after scrolling
    // a few viewports past the hydrate trigger.
    //
    // Memory math unchanged: 13,969 cards × 30 KB = 420 MB if all
    // hydrated; after dehydration kicks in for far cards, we hold
    // ~25-50 hydrated × 30 KB = ~1.5 MB. Long sessions stay bounded.
    if (typeof IntersectionObserver === "function") {
      _dehydrateObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const card = entry.target;
          // With rootMargin "600% 0px", isIntersecting:false means the
          // card is OUTSIDE the 13-viewport-tall expanded root box —
          // i.e., 6+ viewport heights above or below visible. Safe to
          // dehydrate without disrupting anything the user can see.
          if (!entry.isIntersecting && card.dataset.rendered === "1") {
            const sym = card.dataset.sym;
            const inst = sym ? getInstrument(sym) : null;
            if (!inst) continue;
            card.innerHTML = `
              <div class="stock-head">
                <div class="stock-avatar">${escapeHtml(inst.logo || inst.symbol.slice(0, 3))}</div>
                <div class="stock-title">
                  <div class="name">${escapeHtml(inst.name)}</div>
                  <div class="sym">${_stubSubLine(inst)}</div>
                </div>
              </div>
              <div class="skeleton" style="width: 96px; height: 20px; margin-top: 6px;" aria-label="Loading price"></div>
              <div class="skeleton" style="width: 70px; height: 12px; margin-top: 6px;" aria-label="Loading change"></div>
              <div class="skeleton" style="width: 100%; height: 40px; margin-top: 8px;" aria-label="Loading sparkline"></div>
            `;
            card.dataset.stub = "1";
            card.dataset.rendered = "";
            card.classList.add("stock-card-stub");
          }
        }
      }, {
        root: null,
        rootMargin: DEHYDRATE_ROOT_MARGIN,
        threshold: 0,
      });
    }

    host.querySelectorAll(".stock-card[data-sym]").forEach(card => {
      try { _cardObserver.observe(card); } catch {}
      try { _dehydrateObserver?.observe(card); } catch {}
    });
  }

  // Single delegated click handler on the grid host. Replaces 2N per-card
  // listeners (card click + watchlist toggle) with ONE listener that bubbles
  // events up and dispatches via .closest(). At 2,364 stocks: 4,728 → 1,
  // a 99.98% reduction in listener objects. Kills the 4-6 s "Show all" freeze.
  // Uses host.onclick = ... so re-calls cleanly replace prior bindings (no
  // double-fire on re-render).
  function attachGridDelegation(host) {
    if (!host) return;
    host.onclick = (e) => {
      // Watchlist toggle wins over card-click — handle it first and stop.
      const wlBtn = e.target.closest(".watchlist-toggle");
      if (wlBtn) {
        e.stopPropagation();
        const sym = wlBtn.dataset.sym;
        if (!sym) return;
        const wl = new Set(getState().watchlist);
        const wasWatched = wl.has(sym);
        // In-place DOM patch BEFORE the state mutation — fast visual feedback
        // and avoids relying on the subscribe re-render path. The subscribe
        // diff in renderStocks() will detect the watchlist change and call
        // render() but the user already sees the star flip immediately
        // here, so no perceived lag.
        wlBtn.textContent = wasWatched ? "☆" : "★";
        wlBtn.title = wasWatched ? "Add to watchlist" : "Remove from watchlist";
        wlBtn.setAttribute("aria-label", wasWatched ? "Add" : "Remove");
        if (wasWatched) removeFromWatchlist(sym);
        else addToWatchlist(sym);
        return;
      }
      const card = e.target.closest(".stock-card[data-sym]");
      if (card && card.dataset.sym) {
        location.hash = "#/stocks/" + card.dataset.sym;
      }
    };
  }
}

// Hotfix28b: detect "highest/lowest/biggest/top X" queries that map
// to a single fundamentals_cache column, and route them to the
// deterministic /api/screener endpoint instead of the LLM. The LLM
// can't actually answer these queries because the candidates table
// it sees has no 52w-high / market-cap / etc. columns â€” the
// fundamentals data lives only in Supabase. By detecting the pattern
// up front and going straight to the SQL sort, we get correct
// results in <100 ms with zero LLM tokens spent. Returns the same
// shape as opMarketSearch so the existing aiSearch render path
// handles screener results identically.
function detectScreenerQuery(query) {
  const q = query.toLowerCase().trim();
  // Order phrases â€” a stronger word ("highest") wins over a generic
  // word ("biggest") if both match.
  const desc = /\b(highest|biggest|largest|most|top|priciest|costliest)\b/;
  const asc = /\b(lowest|smallest|least|bottom|cheapest)\b/;
  // Metric phrases. Each maps query language to a fundamentals_cache
  // column. Order matters â€” more specific phrases first.
  const metricPatterns = [
    [/\b52[\s-]?(?:week|w|wk)[\s-]?high\b|\bone[\s-]?year[\s-]?high\b|\b1y[\s-]?high\b|\byearly[\s-]?high\b/, "fifty_two_week_high"],
    [/\b52[\s-]?(?:week|w|wk)[\s-]?low\b|\bone[\s-]?year[\s-]?low\b|\b1y[\s-]?low\b|\byearly[\s-]?low\b/,  "fifty_two_week_low"],
    [/\bmarket[\s-]?cap(italization)?\b|\bmcap\b/,                                                          "market_cap"],
    [/\bp\/?e\b|\bprice[\s-]?to[\s-]?earnings\b/,                                                           "pe_ratio"],
    [/\bp\/?b\b|\bprice[\s-]?to[\s-]?book\b/,                                                                "pb_ratio"],
    [/\b(dividend[\s-]?yield|yield|dividend)\b/,                                                             "dividend_yield"],
    [/\bbeta\b/,                                                                                              "beta"],
    [/\broe\b|\breturn[\s-]?on[\s-]?equity\b/,                                                                "roe"],
    [/\beps\b|\bearnings[\s-]?per[\s-]?share\b/,                                                              "eps"],
    [/\bdebt[\s-]?to[\s-]?equity\b|\bd\/?e\b|\bdebt\b|\bleverage\b|\bleveraged\b/,                            "debt_to_equity"],
    // ETF-specific. AUM (assets under management) is the fund-side
    // equivalent of market cap. Expense ratio is a fee. Tracking
    // error is how closely the ETF mirrors its index.
    [/\bassets[\s-]?under[\s-]?management\b|\baum\b/,                                                          "aum"],
    [/\bexpense[\s-]?ratio\b|\bfees?\b|\bcheap(est)?[\s-]?etf/,                                                 "expense_ratio"],
    [/\btracking[\s-]?error\b/,                                                                                  "tracking_error"],
    // Hotfix43b: 'highest price', 'priciest', 'most expensive stock' etc.
    // Maps to fifty_two_week_high as a proxy for current per-share price
    // (fundamentals_full.json doesn't yet ship last_price; the 52w high
    // tracks current price closely for stocks near their peak â€” MRF,
    // Page Industries, etc. all show â‚¹50k+ regardless of which we use).
    // Will switch to last_price after the next fundamentals refresh
    // includes that field. Keep this AFTER the pe/pb/yield patterns so
    // 'price-to-earnings' / 'price-to-book' don't accidentally match
    // here. The negative lookahead guards 'price-to-' compounds.
    [/\b(price|priciest|costliest|most[\s-]?expensive|stock[\s-]?price|share[\s-]?price)\b(?![\s-]?(?:to|tag))/, "fifty_two_week_high"],
  ];
  // Optional kind filter â€” query mentions 'etf' or 'mutual fund' or
  // 'stock' to restrict the universe.
  const kindMatch =
    /\bmutual[\s-]?funds?\b|\bmfs?\b|\bsips?\b|\belss\b/.test(q) ? "MF" :
    /\b(etfs?|exchange[\s-]?traded[\s-]?fund)\b/.test(q) ? "ETF" :
    /\b(stocks?|equit(y|ies)|share[s]?)\b/.test(q) ? "STOCK" :
    null;
  // Detect stock/ETF metric. metric stays null if no pattern matched
  // (e.g., a pure MF query like "highest NAV mutual fund" doesn't
  // mention any stock metric word).
  let metric = null;
  for (const [re, col] of metricPatterns) { if (re.test(q)) { metric = col; break; } }
  // MF override: NAV is the only sortable metric we have for the MF
  // universe (mfFull.json doesn't ship AUM or expense ratio). If the
  // query targets MFs, force metric=nav â€” regardless of whether a
  // stock metric matched above. Even "highest market cap mutual fund"
  // semantically means "biggest MF" which we approximate via NAV.
  if (kindMatch === "MF") {
    metric = "nav";
  }
  if (!metric) return null;
  let order = null;
  if (desc.test(q)) order = "desc";
  else if (asc.test(q)) order = "asc";
  // For most metrics the natural reading of the bare metric name is
  // descending ("the 52-week high" implies the biggest). Default to
  // desc if a direction word is absent.
  if (!order) order = "desc";
  return { metric, order, kind: kindMatch };
}

async function runAiSearch(query, render) {
  if (aiSearchLoading) return;
  // Abort any prior in-flight AI call so stale responses can't overwrite the
  // current one.
  if (aiSearchAbort) { try { aiSearchAbort.abort(); } catch {} }
  aiSearchAbort = new AbortController();
  const signal = aiSearchAbort.signal;

  // Hotfix43a: hard timeout. Without this the fetch can hang indefinitely
  // (Vercel function silent-stall, Cloudflare middlebox holding the
  // connection, slow upstream LLM, etc.) and aiSearchLoading stays true
  // forever â€” the Ask Saathi button is stuck in the 'â€¦' state, the user
  // can never search again. User-reported: 'sometimes the ask saathi
  // search button goes like this' (screenshot of stuck loading state).
  // 12 s gives the slow LLM path a fair shot while still recovering
  // a stuck UI within a sensible window.
  const timeoutId = setTimeout(() => {
    try { aiSearchAbort?.abort(); } catch {}
  }, 12_000);

  aiSearchLoading = true;
  aiSearchQuery = query;
  render();
  try {
    // Try the deterministic screener path first. If the query maps to
    // a known sortable metric, /api/screener returns a SQL-sorted top-N
    // from fundamentals_cache â€” correct, fast, no LLM tokens.
    const screen = detectScreenerQuery(query);
    let d;
    if (screen) {
      // MF queries: screen client-side from the loaded INSTRUMENTS
      // (mfFull.json is already fetched at page load via
      // ensureMfUniverseLoaded). Avoids a wasted API round-trip and
      // keeps MF universe (~14k rows) off the server.
      if (screen.kind === "MF" && screen.metric === "nav") {
        await ensureMfUniverseLoaded();
        if (signal.aborted) return;
        const all = getAllInstruments();
        // Hotfix46c: also skip terminated/wound-up funds so 'highest NAV
        // mutual fund' doesn't return zombie schemes whose final pre-
        // maturity NAV happened to be high.
        const mfs = all.filter(i => i.kind === "MF" && typeof i.nav === "number" && i.nav > 0 && !_isMfTerminated(i));
        mfs.sort((a, b) => screen.order === "desc" ? b.nav - a.nav : a.nav - b.nav);
        const top = mfs.slice(0, 12);
        const direction = screen.order === "desc" ? "highest" : "lowest";
        // Use ₹ (₹) as a JS escape to dodge any UTF-8 mojibake â€”
        // a previous attempt embedded the literal char and the file
        // ended up double-encoded by an editor + Bash combination.
        const RUPEE = "₹";
        // Show fund names in the rationale, not AMFI scheme codes
        // (e.g. 'MF_148398' is meaningless to the user). Truncate
        // long names to keep the rationale readable.
        const sample = top.slice(0, 3).map(m => {
          const nm = (m.name || m.symbol).replace(/ - (Direct|Regular) Plan.*$/i, "").slice(0, 40);
          return `${nm} (${RUPEE}${m.nav.toFixed(2)})`;
        }).join("; ");
        d = {
          matches: top.map(m => m.symbol),
          rationale: top.length
            ? `Top ${top.length} mutual funds by ${direction} NAV: ${sample}`
            : "No mutual funds with NAV data loaded yet.",
          source: "client_mf",
        };
      } else {
        const kindParam = screen.kind ? `&kind=${encodeURIComponent(screen.kind)}` : "";
        const url = `/api/screener?metric=${encodeURIComponent(screen.metric)}&order=${encodeURIComponent(screen.order)}&limit=12${kindParam}`;
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error("http_" + res.status);
        d = await res.json();
      }
    } else {
      // Free-text query that needs LLM interpretation.
      const candidates = buildAiSearchCandidates(query);
      const res = await fetch("/api/ai?op=market-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, candidates }),
        signal,
      });
      if (!res.ok) throw new Error("http_" + res.status);
      d = await res.json();
    }
    if (signal.aborted) return;
    if (d?.matches?.length) {
      aiSearch = { matches: d.matches, rationale: d.rationale || "" };
      // Auto-switch the kind tab so the matches actually display. The
      // applyFilters AI-search branch ALSO applies the active kind
      // filter on top, so an MF-kind result on the Stocks tab gets
      // filtered to empty â€” user sees '12 matches' in the banner +
      // 'No matches' in the grid. Implicit-tab-switch fixes this:
      // typing 'highest NAV mutual fund' implies the user wants the
      // MF tab, even if they were on Stocks.
      if (screen?.kind && filter.kind !== screen.kind) {
        filter.kind = screen.kind;
      }
    } else {
      // Heuristic detection of "asked about a metric we don't have" so the
      // user gets a useful explanation rather than a generic 'try again'.
      // Today only 'debt' is in this bucket â€” fundamentals_cache doesn't
      // store debt-to-equity or absolute debt yet (pending Phase 2 of
      // Hotfix28). Saying that out loud is friendlier than "0 matches".
      const ql = query.toLowerCase();
      let rationale = d?.rationale || "No matches in the current universe.";
      if (/\b(borrow|liability|liabilit)\b/.test(ql) && !/\bdebt\b/.test(ql)) {
        rationale = "Saathi doesn't track absolute borrowings yet. Try 'highest debt-to-equity' (a leverage ratio) or other queries about price, P/E, dividend yield, market cap, 52-week high/low, beta, ROE.";
      } else if (/\b(volume|liquidity|turnover|float)\b/.test(ql)) {
        rationale = "Saathi doesn't track trading volume in the universe yet. Try queries about price, P/E, dividend yield, market cap, 52-week high/low, beta, ROE, or sectors.";
      } else if (/\b(promoter|insider|shareholding|fii|dii)\b/.test(ql)) {
        rationale = "Saathi doesn't have shareholding-pattern data yet. Try queries about price, P/E, dividend yield, market cap, 52-week high/low, beta, ROE, or sectors.";
      }
      aiSearch = { matches: [], rationale };
    }
  } catch (e) {
    if (signal.aborted || e.name === "AbortError") {
      // If the abort came from our 12 s timeout, surface a clear
      // rationale so the user knows to try again rather than seeing
      // a silent empty state.
      if (signal.aborted && !aiSearch) {
        aiSearch = { matches: [], rationale: "Saathi took too long — try again with a shorter query." };
      }
      return;
    }
    aiSearch = { matches: [], rationale: "Saathi couldn't search just now. Try again in a moment." };
  } finally {
    clearTimeout(timeoutId);
    if (aiSearchAbort && aiSearchAbort.signal === signal) aiSearchAbort = null;
    aiSearchLoading = false;
    render();
  }
}

// Client-side prefilter: parse the query for sector / cap-bucket / risk /
// numeric hints, intersect with the full universe, rank by index prominence,
// truncate to the top 150 before handing to the LLM. At 2700 instruments a
// naive slice(0, 200) would silently miss 92% of the universe and burn ~62k
// input tokens per query; this keeps token cost flat vs curated-only while
// making every NSE symbol reachable.
function buildAiSearchCandidates(query) {
  const full = getAllInstruments();
  const byCap = new Map(full.map(i => [i.symbol, i.capBucket || "unknown"]));
  const q = query.toLowerCase();

  // 1) Parse hints
  const capHints = new Set();
  for (const [kw, buckets] of Object.entries(CAP_KEYWORDS)) {
    if (q.includes(kw)) buckets.forEach(b => capHints.add(b));
  }
  const riskHints = new Set();
  for (const [kw, r] of Object.entries(RISK_KEYWORDS)) {
    if (q.includes(kw)) riskHints.add(r);
  }
  const sectorHints = new Set();
  for (const s of getAllSectors()) {
    const sl = s.toLowerCase();
    if (sl && sl !== "other" && q.includes(sl)) sectorHints.add(s);
  }
  // Broader keyword → sector aliases that NSE doesn't name directly.
  // NOTE: each value MUST be a sector string that actually exists in the
  // universe (curated.js + universeFull.json). Banking/Pharma/Insurance are
  // curated-only — Tier-2 banks fall back to "Other" so the keyword still
  // helps narrow the curated subset.
  const SECTOR_ALIASES = {
    bank: "Banking", banks: "Banking", banking: "Banking", psu: "Banking",
    pharma: "Pharma", pharmaceutical: "Pharma", drug: "Pharma", medicine: "Pharma",
    it: "IT Services", tech: "IT Services", software: "IT Services", saas: "IT Services",
    auto: "Auto", car: "Auto", motor: "Auto", vehicle: "Auto", "ev": "Auto", "electric vehicle": "Auto",
    fmcg: "FMCG", consumer: "Consumer", "consumer goods": "FMCG",
    "consumer electronics": "Consumer Elec", appliance: "Consumer Elec", electronic: "Consumer Elec",
    metal: "Metals", steel: "Metals", aluminium: "Metals", copper: "Metals", mining: "Metals",
    oil: "Energy", gas: "Energy", energy: "Energy", petroleum: "Energy", refinery: "Energy",
    power: "Power", electric: "Power", utility: "Power", utilities: "Power", renewable: "Power", solar: "Power",
    realty: "Real Estate", "real estate": "Real Estate", property: "Real Estate", housing: "Real Estate",
    cement: "Cement",
    telecom: "Telecom", mobile: "Telecom", "5g": "Telecom",
    insurance: "Insurance",
    finance: "NBFC", nbfc: "NBFC", lending: "NBFC", financial: "NBFC", financier: "NBFC",
    chemical: "Chemicals", specialty: "Chemicals",
    fertilizer: "Chemicals", fertiliser: "Chemicals", agro: "Chemicals", agri: "Chemicals",
    paint: "Chemicals", agrochemical: "Chemicals",
    infrastructure: "Construction", infra: "Construction",
    construction: "Construction", builder: "Construction", "epc": "Construction",
    shipping: "Services", shipyard: "Services", port: "Services", logistics: "Services",
    courier: "Services", warehouse: "Services", transport: "Services", "supply chain": "Services",
    media: "Services", broadcaster: "Services", entertainment: "Services",
    travel: "Services", hotel: "Services", hospitality: "Services", tourism: "Services",
    airline: "Services", aviation: "Services",
    retail: "Services", ecommerce: "Services", internet: "Services",
    healthcare: "Healthcare", hospital: "Healthcare", diagnostic: "Healthcare", clinic: "Healthcare",
    diversified: "Conglomerate", conglomerate: "Conglomerate",
    etf: "ETF", "exchange traded": "ETF", "index fund": "ETF",
  };
  for (const [kw, sec] of Object.entries(SECTOR_ALIASES)) {
    if (q.includes(kw)) sectorHints.add(sec);
  }

  // 1b) Parse numeric hints — "PE < 30", "P/E under 20", "yield > 2%", "yield over 3",
  //     "beta below 1". These are precise signals the LLM has to otherwise
  //     infer from the table — turning them into hard filters cuts the
  //     candidate pool, lifts result quality, and stops wasting the model's
  //     reasoning budget on arithmetic.
  const numHints = parseNumericHints(q);
  // "cheap" / "expensive" qualitative cues map to PE/PB ranges so a query
  // like "cheap pharma" filters with PE<=18 instead of relying on the LLM.
  if (numHints.peMax == null && /\b(cheap|undervalued|low pe|low p\/e|value)\b/.test(q)) {
    numHints.peMax = 18;
  }
  if (numHints.peMin == null && /\b(expensive|overvalued|premium|growth|growth stock)\b/.test(q)) {
    numHints.peMin = 35;
  }
  // "dividend payers" / "high dividend" / "income" — the LLM is bad at
  // numeric comparisons across 150 rows; pin it.
  if (numHints.divMin == null && /\b(dividend payer|dividend payers|high dividend|high yield|income stock|income stocks|payer)\b/.test(q)) {
    numHints.divMin = 1.5;
  }

  // 2) Prefilter
  let pool = full;
  if (sectorHints.size) pool = pool.filter(i => sectorHints.has(i.sector));
  if (capHints.size) pool = pool.filter(i => capHints.has(byCap.get(i.symbol)));
  if (riskHints.size) pool = pool.filter(i => riskHints.has(i.risk || "med"));
  // Numeric filters are tolerant: rows missing the field pass through (Tier-2
  // typically has null pe/pb/divYield) so we don't over-prune the universe.
  if (numHints.peMax != null)  pool = pool.filter(i => i.pe == null || i.pe <= numHints.peMax);
  if (numHints.peMin != null)  pool = pool.filter(i => i.pe == null || i.pe >= numHints.peMin);
  if (numHints.divMin != null) pool = pool.filter(i => i.divYield == null || i.divYield >= numHints.divMin);
  if (numHints.betaMax != null) pool = pool.filter(i => i.beta == null || i.beta <= numHints.betaMax);

  // 3) Rank by index prominence (Nifty50 first, then 100, 500, midcap, smallcap, rest)
  // Higher idx bits = more prominent; sort desc. Fall back to name-length
  // as a tie-breaker so stable ordering.
  pool.sort((a, b) => {
    const ai = a.idx || 0;
    const bi = b.idx || 0;
    if (ai !== bi) return bi - ai;   // reverse of bit-value — higher idx bits = more prominent
    return (a.symbol || "").localeCompare(b.symbol || "");
  });

  // 4) Fallback to full if prefilter killed everything (query is purely
  // qualitative — "defensive dividend payers" with no sector word).
  if (pool.length < 20) {
    pool = full.slice().sort((a, b) => (b.idx || 0) - (a.idx || 0));
  }

  const TOP = 150;
  return pool.slice(0, TOP).map(i => {
    const q2 = quoteCache[i.symbol];
    const row = {
      symbol: i.symbol,
      name: i.name,
      sector: i.sector || "",
      pe: i.pe ?? null,
      pb: i.pb ?? null,
      divYield: i.divYield ?? null,
      beta: i.beta ?? null,
      risk: i.risk || "",
      dayPct: q2?.changePct != null ? q2.changePct * 100 : null,
    };
    // Only include marketCap when populated (curated rows). Tier-2 rows ship
    // it as "" — sending an empty field for ~140 rows wastes ~280 tokens
    // for nothing.
    if (i.marketCap) row.marketCap = i.marketCap;
    return row;
  });
}

// Pulls "PE < 30", "P/E under 20", "yield > 2%", "beta below 1.2" etc. out
// of a free-text query. Returns an object with {peMin, peMax, divMin,
// betaMax} where each is a number or undefined. Bounds are clamped to
// sensible ranges so a typo can't silently kill the candidate pool.
function parseNumericHints(q) {
  const out = {};
  const num = (s) => { const n = Number(s); return isFinite(n) ? n : null; };
  // PE: "pe < 30", "p/e under 20", "pe below 25", "pe over 40"
  const peLt = q.match(/p\/?e\s*(?:<|under|below|less than|max|<=)\s*(\d+(?:\.\d+)?)/);
  if (peLt) { const n = num(peLt[1]); if (n != null && n > 0 && n < 500) out.peMax = n; }
  const peGt = q.match(/p\/?e\s*(?:>|over|above|greater than|more than|min|>=)\s*(\d+(?:\.\d+)?)/);
  if (peGt) { const n = num(peGt[1]); if (n != null && n >= 0 && n < 500) out.peMin = n; }
  // Yield: "yield > 2", "yield over 3%", "dividend > 2"
  const dyGt = q.match(/(?:yield|dividend)\s*(?:>|over|above|min|greater than|more than|>=)\s*(\d+(?:\.\d+)?)/);
  if (dyGt) { const n = num(dyGt[1]); if (n != null && n >= 0 && n < 50) out.divMin = n; }
  // Beta: "beta < 1", "beta below 1.2"
  const beLt = q.match(/beta\s*(?:<|under|below|less than|max|<=)\s*(\d+(?:\.\d+)?)/);
  if (beLt) { const n = num(beLt[1]); if (n != null && n > 0 && n < 5) out.betaMax = n; }
  return out;
}

async function fetchMarketMood() {
  const bySector = {};
  for (const inst of INSTRUMENTS) {
    const q = quoteCache[inst.symbol];
    if (!q || typeof q.changePct !== "number" || !inst.sector) continue;
    if (!bySector[inst.sector]) bySector[inst.sector] = { pcts: [], up: { sym: "", pct: -Infinity }, down: { sym: "", pct: Infinity } };
    const pct = q.changePct * 100;
    bySector[inst.sector].pcts.push(pct);
    if (pct > bySector[inst.sector].up.pct) bySector[inst.sector].up = { sym: inst.symbol, pct };
    if (pct < bySector[inst.sector].down.pct) bySector[inst.sector].down = { sym: inst.symbol, pct };
  }
  const sectors = Object.entries(bySector)
    .map(([name, v]) => ({
      name,
      avgPct: v.pcts.reduce((a, b) => a + b, 0) / v.pcts.length,
      count: v.pcts.length,
      topUp: v.up.sym ? `${v.up.sym} ${v.up.pct>=0?"+":""}${v.up.pct.toFixed(1)}%` : "",
      topDown: v.down.sym ? `${v.down.sym} ${v.down.pct>=0?"+":""}${v.down.pct.toFixed(1)}%` : "",
    }))
    .sort((a, b) => Math.abs(b.avgPct) - Math.abs(a.avgPct))
    .slice(0, 10);
  if (!sectors.length) return null;
  const r = await fetch("/api/ai?op=market-mood", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sectors, asOf: Date.now() }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  if (!d?.narrative) return null;
  return d;
}

function changeFor(sym, quoteCache) {
  const q = quoteCache?.[sym];
  if (q && Number.isFinite(q.changePct)) return q.changePct;
  return getTodayChange(sym);
}

function applyFilters(all, f, state, quoteCache) {
  // If an AI-search result is active, it overrides the keyword filter
  // entirely — show exactly the AI's ordered matches. Other filters
  // (sector, kind) still stack on top.
  if (aiSearch && aiSearch.matches && aiSearch.matches.length) {
    const orderMap = new Map(aiSearch.matches.map((s, i) => [s, i]));
    let list = all.filter(i => orderMap.has(i.symbol));
    if (f.kind === KIND_EQUITY) list = list.filter(i => i.kind === KIND_EQUITY);
    else if (f.kind === KIND_ETF) list = list.filter(i => i.kind === KIND_ETF);
    else if (f.kind === KIND_MF) list = list.filter(i => i.kind === KIND_MF);
    else if (f.kind === "watchlist") {
      const wl = new Set(state.watchlist);
      list = list.filter(i => wl.has(i.symbol));
    }
    // Hotfix63a: pill row now feeds canonical Groww categories,
    // so filter.sector holds a canonical name (e.g. "Oil & Gas")
    // rather than the raw NSE bucket. Map each instrument through
    // getCanonicalCategory and compare.
    if (f.sector !== "all") list = list.filter(i => getCanonicalCategory(i) === f.sector);
    list.sort((a, b) => orderMap.get(a.symbol) - orderMap.get(b.symbol));
    return list;
  }
  let list = all.slice();
  if (f.kind === KIND_EQUITY) list = list.filter(i => i.kind === KIND_EQUITY);
  else if (f.kind === KIND_ETF) list = list.filter(i => i.kind === KIND_ETF);
  else if (f.kind === KIND_MF) {
    list = list.filter(i => i.kind === KIND_MF);
    // Hotfix46c: filter out wound-up / zombie schemes by default. ~5,000
    // of the ~14,000 MFs in mfFull.json have nav_date >3 years old (e.g.
    // Kotak Monthly Interval Plan Series 4 last published 2019-04-22)
    // â€” showing them in the default screener clutters the user's view
    // with un-investable funds. Same isTerminatedFund logic as the
    // detail-page banner: nav < 0.01 OR nav_date > 365 days old.
    list = list.filter(i => !_isMfTerminated(i));
    // MF-specific facets: category bucket (Equity/Debt/Hybrid/Index/etc.)
    // and plan type (Direct/Regular). Both default to "all".
    if (f.mfBucket && f.mfBucket !== "all") {
      list = list.filter(i => i.category_bucket === f.mfBucket);
    }
    if (f.mfPlan && f.mfPlan !== "all") {
      list = list.filter(i => i.plan_type === f.mfPlan);
    }
  }
  else if (f.kind === "watchlist") {
    const wl = new Set(state.watchlist);
    list = list.filter(i => wl.has(i.symbol));
  }
  // Sector filter only applies outside MF mode (MFs use mfBucket).
  // Hotfix63a: filter.sector is now a canonical Groww category — map
  // each instrument's raw .sector through getCanonicalCategory before
  // comparing.
  if (f.kind !== "MF" && f.sector !== "all") list = list.filter(i => getCanonicalCategory(i) === f.sector);
  if (f.q) {
    const q = f.q.toLowerCase();
    list = list.filter(i =>
      i.name.toLowerCase().includes(q) ||
      i.symbol.toLowerCase().includes(q) ||
      (i.sector || "").toLowerCase().includes(q)
    );
  }
  if (f.sort === "gainers") list.sort((a, b) => changeFor(b.symbol, quoteCache) - changeFor(a.symbol, quoteCache));
  else if (f.sort === "losers") list.sort((a, b) => changeFor(a.symbol, quoteCache) - changeFor(b.symbol, quoteCache));
  else if (f.sort === "name") list.sort((a, b) => (a.name || a.symbol || "").localeCompare(b.name || b.symbol || ""));
  else if (f.sort === "marketCap") {
    // Sort by index-membership prominence (Nifty 50 > Nifty 100 > Nifty 500 >
    // Mid150 > Small250 > rest). Pre-Landing-F we used parseMarketCapCr on
    // hand-typed marketCap strings; those fields are now null per the
    // user's "zero hand-typed data" rule. idx_tags is computed at build time
    // from index constituents (build-universe.mjs) and is the closest proxy
    // to "size" we have without an LLM-token-burning live fundamentals
    // call per card. Tie-break by symbol so order is stable.
    //
    // ETF prominence boost: every ETF row ships with idx=0 because
    // build-universe.mjs only computes index membership for Nifty equity
    // indices. Without this boost, ETFs sorted alphabetically and the most
    // popular ones (NIFTYBEES, GOLDBEES, BANKBEES, JUNIORBEES, LIQUIDBEES)
    // were buried hundreds of rows deep behind no-name "AB..." schemes.
    // Bump these well-known tickers up via a hand-curated boost table.
    // Real fix needs AUM ingestion in the build script — this is the
    // stopgap until that lands.
    const ETF_PROMINENCE = {
      NIFTYBEES: 100, GOLDBEES: 95, BANKBEES: 90, JUNIORBEES: 85,
      LIQUIDBEES: 80, SETFNIF50: 75, KOTAKLIQ: 70, ICICILIQ: 65,
      CPSEETF: 60, ITBEES: 55, PSUBNKBEES: 50, SHARIABEES: 45,
      MIDCAP150: 65, NIFTYIETF: 70, SETFNN50: 60, NIF100IETF: 60,
      SILVERBEES: 65, SETFGOLD: 50,
    };
    list.sort((a, b) => {
      let ai = a.idx || a.idx_tags || 0;
      let bi = b.idx || b.idx_tags || 0;
      if (a.kind === "ETF") ai = ETF_PROMINENCE[a.symbol] || ai;
      if (b.kind === "ETF") bi = ETF_PROMINENCE[b.symbol] || bi;
      if (ai !== bi) return bi - ai;
      return (a.symbol || "").localeCompare(b.symbol || "");
    });
  }
  return list;
}

// ── Stub card — minimal HTML emitted at first paint for every row ──────────
// Pre-Hotfix4: clicking "Show all 2,364" rendered every card fully-hydrated
// into a single innerHTML write (~1.4 MB string + 4,728 attached listeners),
// stalling the main thread for 4–6 s on mid-range Android. Now we ship
// stubs instead — ~200 chars apiece, no listeners, fixed layout box —
// and the IntersectionObserver in attachCardObserver() upgrades each
// stub to a full card body the moment it scrolls into view (200% root
// margin, so users never see the skeleton flash on a typical scroll).
//
// `min-height: 172px` preserves the layout box so the IO doesn't get
// confused by zero-height rows and so the user's scroll position stays
// consistent through the hydrate transition.
// Format the symbol-line subtitle so MF cards show "AMC · Category" instead
// of "MF_118718 · Equity" (technical AMFI code looks like garbage to users).
// Equities/ETFs keep their existing "SYMBOL · Sector" layout.
function _stubSubLine(inst) {
  if (inst.kind === KIND_MF) {
    // AMC short name (first 2 words) is more recognisable than MF_<code>.
    // category_bucket is set to inst.sector by universeLoader, but use
    // category_bucket explicitly here in case sector ever ships differently.
    const amcShort = inst.amc
      ? escapeHtml(inst.amc.split(/\s+/).slice(0, 2).join(" "))
      : escapeHtml(inst.symbol);
    const cat = inst.category_bucket || inst.sector;
    return cat && cat !== "Unknown" ? `${amcShort} · ${escapeHtml(cat)}` : amcShort;
  }
  const sectorBit = inst.sector && inst.sector !== "Unknown" ? ` · ${escapeHtml(inst.sector)}` : "";
  return `${escapeHtml(inst.symbol)}${sectorBit}`;
}

function renderStubCard(inst) {
  return `<div class="stock-card stock-card-stub" data-sym="${inst.symbol}" data-stub="1" role="button" tabindex="0" aria-label="${escapeAttr(inst.name)}" style="min-height: 172px;">
    <div class="stock-head">
      <div class="stock-avatar">${escapeHtml(inst.logo || inst.symbol.slice(0, 3))}</div>
      <div class="stock-title">
        <div class="name">${escapeHtml(inst.name)}</div>
        <div class="sym">${_stubSubLine(inst)}</div>
      </div>
    </div>
    <div class="skeleton" style="width: 96px; height: 20px; margin-top: 6px;" aria-label="Loading price"></div>
    <div class="skeleton" style="width: 70px; height: 12px; margin-top: 6px;" aria-label="Loading change"></div>
    <div class="skeleton" style="width: 100%; height: 40px; margin-top: 8px;" aria-label="Loading sparkline"></div>
  </div>`;
}

function renderStockCard(inst, state, wlSet) {
  // Always pull the deterministic seeded walk from prices.js — it has a
  // Tier-2 stub-fallback that produces a believable per-symbol synthetic
  // chart even when there's no live quote yet. The intraday buffer
  // overlays once subscribeToQuotes lands a tick. Drops the previous
  // `inst.price != null` gate that left ALL Tier-2 cards with empty
  // sparklines forever (the gate was a vestige of the hand-typed era).
  const seededCloses = getCloses(inst.symbol, SPARKLINE_SEED_LENGTH);
  const closes = getIntradaySparkline(inst.symbol, seededCloses);
  const quote = quoteCache[inst.symbol];
  const hasLive = quote?.pricePaise != null;
  // MF NAV fallback: MFs never get a live quote (they're filtered out of
  // symbolsToPoll() because Yahoo has no MF intraday data). Without this
  // fallback the card showed "—" + "NAV NAV" — visible nonsense.
  // inst.nav is rupees from AMFI; convert to paise so formatRupees works.
  const navFallbackPaise = (inst.kind === KIND_MF && typeof inst.nav === "number" && inst.nav > 0)
    ? Math.round(inst.nav * 100)
    : null;
  const price = hasLive ? quote.pricePaise : navFallbackPaise;
  const change = quote?.changePct ?? getTodayChange(inst.symbol);
  // wlSet is hoisted at render time — O(1) membership check; old code used
  // state.watchlist.includes(sym) which was O(n) per card.
  const isWatched = wlSet ? wlSet.has(inst.symbol) : state.watchlist.includes(inst.symbol);
  // Badge logic:
  //   market-closed  → CLOSED pill with last-close time (even if we have a quote
  //                    cached from the final trading tick, it's by definition
  //                    not live anymore outside session hours)
  //   MF             → NAV (end-of-day; no intraday NSE feed for mutual funds)
  //   live & fresh   → LIVE
  //   live & stale   → DELAYED Xm old
  //   seeded only    → SYNCING
  const ms = marketStatus();
  let badge = "";
  if (inst.kind === KIND_MF) {
    badge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Mutual Fund NAV — refreshed once per day after market close">NAV</span>`;
  } else if (ms.state !== "open") {
    const lbl = ms.state === "pre-open" ? "PRE-OPEN" : "CLOSED";
    // Stock-specific tooltip. The market-hours explainer already lives on
    // the nav's global market-status pill — no need to duplicate it on
    // every stock card. Here we show information relevant to THIS stock:
    // last closing price, change for the last session, day range, sector,
    // market cap, P/E if available.
    const lblLong = ms.state === "pre-open" ? "Pre-open" : "Closed";
    const rows = [];
    if (hasLive) {
      rows.push(`<div class="ms-pop-row"><span class="ms-pop-key">Last close</span><span class="tabular">${formatRupees(price)}</span></div>`);
      rows.push(`<div class="ms-pop-row"><span class="ms-pop-key">Change</span><span class="tabular ${deltaClass(change)}">${formatPct(change, { sign: true })}</span></div>`);
      if (quote.high && quote.low && quote.high > 0 && quote.low > 0 && quote.high !== quote.low) {
        rows.push(`<div class="ms-pop-row"><span class="ms-pop-key">Day range</span><span class="tabular">${formatRupees(quote.low)} – ${formatRupees(quote.high)}</span></div>`);
      }
    }
    if (inst.sector && inst.sector !== "Unknown") {
      rows.push(`<div class="ms-pop-row"><span class="ms-pop-key">Sector</span><span>${escapeHtml(inst.sector)}</span></div>`);
    }
    if (inst.cap_bucket || inst.capBucket) {
      const cap = inst.cap_bucket || inst.capBucket;
      const capLabel = { mega: "Mega cap", large: "Large cap", mid: "Mid cap", small: "Small cap", micro: "Micro cap" }[cap] || cap;
      rows.push(`<div class="ms-pop-row"><span class="ms-pop-key">Cap</span><span>${escapeHtml(capLabel)}</span></div>`);
    }
    // Note: PE / Market Cap / Beta / DivYield no longer come from inst.* —
    // they are fetched on-demand from /api/fundamentals when the user opens
    // the stock detail page. Showing them here would require firing 100+
    // /api/fundamentals calls per Markets render, which kills latency. The
    // grid card stays minimal; the detail page does the heavier lookup.
    const pop = `
      <div class="market-status-pop" role="tooltip">
        <div class="ms-pop-head">
          <span class="ms-pop-label">NSE · ${lblLong}</span>
        </div>
        ${rows.join("")}
      </div>
    `;
    badge = `<span class="pill stock-card-ms-pill market-status" tabindex="0" data-ms-state="${ms.state}" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim); position: relative;">${lbl}${pop}</span>`;
  } else if (quote?.source && quote.source !== "mf-static" && quote.source !== "synthetic") {
    if (quote.stale) {
      // 2026-05-04: was misleading 'DELAYED Xm old' for every stale quote.
      // Now uses the helper which distinguishes low-volume (LAST HH:MM,
      // neutral) from real feed lag (LAGGING HH:MM, yellow).
      badge = _stalenessBadge(quote, inst);
    } else {
      badge = `<span class="pill pill-green" style="font-size: 9px; padding: 1px 6px;" title="NSE · Live">LIVE</span>`;
    }
  } else {
    // No live quote yet (Tier-2 cold load before subscribeToQuotes ticks
    // in viewport range). Show a generic SYNCING badge — sparkline still
    // renders from the seeded stub walk so the card isn't blank.
    badge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Live feed syncing — sparkline shows deterministic synthetic walk until first quote tick">SYNCING</span>`;
  }
  const liveBadge = badge;
  return `
    <div class="stock-card" data-sym="${inst.symbol}" data-rendered="1" role="button" tabindex="0" aria-label="${escapeAttr(inst.name)}">
      ${renderStockCardBody(inst, state, wlSet, { closes, hasLive, price, change, isWatched, liveBadge, changeFp: inst.kind === KIND_MF ? null : computeChangeFp(change, quote?.source, quote?.stale, marketStatus().state) })}
    </div>
  `;
}

// Inner HTML of a hydrated stock card. Extracted from renderStockCard so the
// IntersectionObserver hot path can do `card.innerHTML = renderStockCardBody(...)`
// and turn a stub into a full card without re-creating the outer wrapper
// (preserves the click-target, focus, and `data-sym` attribute the event-
// delegation handler reads).
//
// The opts object carries the heavy-to-recompute values from renderStockCard
// when we're going through the full path; on the IO hot path we pass null
// and recompute internally so this can also be called fresh from hydrateCard.
function renderStockCardBody(inst, state, wlSet, opts = null) {
  let closes, hasLive, price, change, isWatched, liveBadge;
  if (opts) {
    ({ closes, hasLive, price, change, isWatched, liveBadge } = opts);
  } else {
    const seededCloses = getCloses(inst.symbol, SPARKLINE_SEED_LENGTH);
    closes = getIntradaySparkline(inst.symbol, seededCloses);
    const quote = (typeof window !== "undefined" && window.__ssQuoteCache) ? window.__ssQuoteCache[inst.symbol] : null;
    hasLive = quote?.pricePaise != null;
    price = hasLive ? quote.pricePaise : null;
    change = quote?.changePct ?? getTodayChange(inst.symbol);
    isWatched = wlSet ? wlSet.has(inst.symbol) : (state?.watchlist || []).includes(inst.symbol);
    const ms = marketStatus();
    if (inst.kind === KIND_MF) {
      liveBadge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Mutual Fund NAV — refreshed once per day after market close">NAV</span>`;
    } else if (ms.state !== "open") {
      const lbl = ms.state === "pre-open" ? "PRE-OPEN" : "CLOSED";
      liveBadge = `<span class="pill stock-card-ms-pill market-status" tabindex="0" data-ms-state="${ms.state}" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);">${lbl}</span>`;
    } else if (quote?.source && quote.source !== "mf-static" && quote.source !== "synthetic") {
      liveBadge = quote.stale
        ? _stalenessBadge(quote, inst)
        : `<span class="pill pill-green" style="font-size: 9px; padding: 1px 6px;" title="NSE · Live">LIVE</span>`;
    } else {
      liveBadge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Live feed syncing">SYNCING</span>`;
    }
  }
  return `
    <div class="stock-head">
      <div class="stock-avatar">${escapeHtml(inst.logo || inst.symbol.slice(0, 3))}</div>
      <div class="stock-title">
        <div class="name">${escapeHtml(inst.name)}</div>
        <div class="sym">${_stubSubLine(inst)}</div>
      </div>
      <button class="watchlist-toggle" data-sym="${inst.symbol}" title="${isWatched ? "Remove from watchlist" : "Add to watchlist"}" aria-label="${isWatched ? "Remove" : "Add"}" style="background: transparent; padding: 4px; font-size: 16px;">${isWatched ? "★" : "☆"}</button>
    </div>
    <div class="flex items-center justify-between">
      <div>
        ${hasLive || inst.kind === KIND_MF ? `
          <div class="stock-price tabular">${formatRupees(price)}</div>
          <div class="stock-change ${deltaClass(change)}"${opts?.changeFp ? ` data-change-fp="${escapeAttr(opts.changeFp)}"` : ""}>${hasLive ? `${formatPct(change, { sign: true })} today` : `<span class="dim">NAV</span>`} ${liveBadge}</div>
        ` : `
          <div class="skeleton" style="width: 96px; height: 20px;" aria-label="Loading price"></div>
          <div class="stock-change" style="display:flex; align-items:center; gap:6px;">
            <span class="skeleton" style="width: 60px; height: 12px;" aria-label="Loading change"></span>
            ${liveBadge}
          </div>
        `}
      </div>
      <span class="risk-pill ${inst.risk || "med"}">${(inst.risk || "MED").toUpperCase()}</span>
    </div>
    <div class="stock-sparkline"${closes && closes.length > 1 ? ` data-spark-fp="${closes.length}:${closes[closes.length - 1]}"` : ""}>${closes && closes.length > 1 ? sparkline(closes) : `<div class="skeleton" style="width: 100%; height: 40px;" aria-label="Loading sparkline"></div>`}</div>
  `;
}

// =============================================================================
// TILE VIEW (Hotfix65b) — alternative compact row layout for /stocks.
// Same data, different markup. Rendered when viewMode === "tiles". Each
// tile keeps the .stock-card[data-sym], .stock-price, .stock-change,
// .stock-sparkline contracts so:
//   - The live-tick patcher (patchHydratedCards) updates tiles in place.
//   - The IntersectionObserver finds + hydrates tile stubs the same way.
//   - The grid click delegation works (.stock-card[data-sym]).
//   - data-spark-fp / data-change-fp guards still work.
// We deliberately render different INNER HTML for tile vs card so the
// layout fits the row form factor — name + ticker visible, smaller
// sparkline, compact price+change stack on the right. The toggle
// handler calls renderList() to redo the whole grid host with the
// new mode's bodies (cheap; <50ms even for 2,400 stocks since stubs
// only).
// =============================================================================

function renderStubRow(inst, mode) {
  return mode === "tiles" ? renderStubTile(inst) : renderStubCard(inst);
}

// Header strip for the tile-view grid. Renders ABOVE the grid so users
// can scan the column meaning. Hidden + omitted in card mode. CSS hides
// volume + 52W headers below their respective viewport breakpoints in
// lockstep with the row cells (same media queries).
function _tileHeaderHtml() {
  return `
    <div class="stocks-grid--tiles-header" role="row">
      <div>Company</div>
      <div class="col-spark"></div>
      <div class="col-num">Market price</div>
      <div class="col-num">1D change</div>
      <div class="col-num col-vol">1D volume</div>
      <div class="col-center col-52w">52W performance</div>
    </div>
  `;
}

// Compact volume formatter — "23.4M" / "1.2L" / "847" / "—" for nullish.
// Used in tile view's volume column.
function _compactVol(n) {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e7) return (n / 1e7).toFixed(2).replace(/\.?0+$/, "") + "Cr";
  if (n >= 1e5) return (n / 1e5).toFixed(2).replace(/\.?0+$/, "") + "L";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.?0+$/, "") + "K";
  return String(Math.round(n));
}

// Compact rupee for 52W bar end labels — "₹1.2K" / "₹3.4L" / "₹128".
function _compactRupees(rupees) {
  if (rupees == null || !Number.isFinite(rupees)) return "—";
  if (rupees >= 1e5) return "₹" + (rupees / 1e5).toFixed(1).replace(/\.0$/, "") + "L";
  if (rupees >= 1e3) return "₹" + (rupees / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return "₹" + Math.round(rupees);
}

// 52W performance bar — "L ──●── H" with current price as a marker.
// Returns "" when range or price are unavailable. Pass currentPaise
// from the price var (paise); range is rupees from get52wRange.
function _render52wBar(currentPaise) {
  let r = null;
  try { r = get52wRange(arguments[1] || "") || null; } catch {}
  if (!r || !Number.isFinite(r.hi) || !Number.isFinite(r.lo) || r.hi <= r.lo || currentPaise == null) {
    return `<div class="tile-52w tile-52w-empty"><span class="dim">—</span></div>`;
  }
  const cur = currentPaise / 100;
  const clamped = Math.max(r.lo, Math.min(r.hi, cur));
  const pct = ((clamped - r.lo) / (r.hi - r.lo)) * 100;
  return `
    <div class="tile-52w" title="52W range ₹${r.lo.toFixed(2)} – ₹${r.hi.toFixed(2)} · now ₹${cur.toFixed(2)}">
      <span class="tile-52w-end">L</span>
      <div class="tile-52w-track"><div class="tile-52w-marker" style="left: ${pct.toFixed(1)}%"></div></div>
      <span class="tile-52w-end">H</span>
    </div>
  `;
}

function renderStubTile(inst) {
  return `<div class="stock-card stock-card-stub stock-tile" data-sym="${inst.symbol}" data-stub="1" role="button" tabindex="0" aria-label="${escapeAttr(inst.name)}">
    <div class="tile-head">
      <div class="stock-avatar tile-avatar">${escapeHtml(inst.logo || inst.symbol.slice(0, 3))}</div>
      <div class="tile-title">
        <div class="tile-name">${escapeHtml(inst.name)}</div>
        <div class="tile-sym">${_stubSubLine(inst)}</div>
      </div>
    </div>
    <div class="stock-sparkline tile-spark"><div class="skeleton" style="width: 100%; height: 100%;"></div></div>
    <div class="tile-price-cell"><div class="skeleton" style="width: 60px; height: 14px;"></div></div>
    <div class="tile-change-cell"><div class="skeleton" style="width: 70px; height: 14px;"></div></div>
    <div class="tile-vol-cell"><div class="skeleton" style="width: 50px; height: 11px;"></div></div>
    <div class="tile-52w-cell"><div class="skeleton" style="width: 90px; height: 14px;"></div></div>
  </div>`;
}

function renderStockBodyForView(inst, state, wlSet, opts, mode) {
  return mode === "tiles"
    ? renderStockTileBody(inst, state, wlSet, opts)
    : renderStockCardBody(inst, state, wlSet, opts);
}

function renderStockTileBody(inst, state, wlSet, opts = null) {
  // Mirror renderStockCardBody's data fork — same fields, just laid out
  // for a Groww-style multi-column row: name | spark | price | change |
  // volume | 52W bar.
  let closes, hasLive, price, change, isWatched, liveBadge;
  let quote = null;
  if (opts) {
    ({ closes, hasLive, price, change, isWatched, liveBadge } = opts);
    quote = (typeof window !== "undefined" && window.__ssQuoteCache) ? window.__ssQuoteCache[inst.symbol] : null;
  } else {
    const seededCloses = getCloses(inst.symbol, SPARKLINE_SEED_LENGTH);
    closes = getIntradaySparkline(inst.symbol, seededCloses);
    quote = (typeof window !== "undefined" && window.__ssQuoteCache) ? window.__ssQuoteCache[inst.symbol] : null;
    hasLive = quote?.pricePaise != null;
    price = hasLive ? quote.pricePaise : null;
    change = quote?.changePct ?? getTodayChange(inst.symbol);
    isWatched = wlSet ? wlSet.has(inst.symbol) : (state?.watchlist || []).includes(inst.symbol);
    const ms = marketStatus();
    if (inst.kind === KIND_MF) {
      liveBadge = `<span class="pill" style="font-size: 8px; padding: 0 5px; background: var(--bg-subtle); color: var(--text-dim);" title="MF NAV">NAV</span>`;
    } else if (ms.state !== "open") {
      const lbl = ms.state === "pre-open" ? "PRE-OPEN" : "CLOSED";
      liveBadge = `<span class="pill stock-card-ms-pill market-status" tabindex="0" data-ms-state="${ms.state}" style="font-size: 8px; padding: 0 5px; background: var(--bg-subtle); color: var(--text-dim);">${lbl}</span>`;
    } else if (quote?.source && quote.source !== "mf-static" && quote.source !== "synthetic") {
      liveBadge = quote.stale
        ? _stalenessBadge(quote, inst, { size: "mini" })
        : `<span class="pill pill-green" style="font-size: 8px; padding: 0 5px;" title="NSE · Live">LIVE</span>`;
    } else {
      liveBadge = `<span class="pill" style="font-size: 8px; padding: 0 5px; background: var(--bg-subtle); color: var(--text-dim);" title="Syncing">SYNCING</span>`;
    }
  }
  const sparkSvg = closes && closes.length > 1
    ? sparkline(closes, { width: 88, height: 28, strokeWidth: 1.5 })
    : `<div class="skeleton" style="width: 100%; height: 100%;"></div>`;
  const sparkFp = closes && closes.length > 1 ? ` data-spark-fp="${closes.length}:${closes[closes.length - 1]}"` : "";
  // Absolute 1D change in rupees: pricePaise - prevClosePaise (if known).
  // Falls back to deriving from changePct: change * prevClose.
  let absChangeStr = "";
  if (hasLive && quote && Number.isFinite(quote.prevClosePaise) && quote.prevClosePaise > 0) {
    const deltaPaise = price - quote.prevClosePaise;
    const deltaR = Math.abs(deltaPaise / 100);
    absChangeStr = (deltaPaise >= 0 ? "+" : "−") + "₹" + (deltaR < 100 ? deltaR.toFixed(2) : deltaR.toFixed(1));
  }
  // Volume — from quote when present.
  const volStr = quote && Number.isFinite(quote.volume) ? _compactVol(quote.volume) : "—";
  // 52W bar — uses prices.js seeded series. Best-effort; non-blocking.
  let bar52 = "";
  try {
    const r = get52wRange(inst.symbol);
    if (r && Number.isFinite(r.hi) && Number.isFinite(r.lo) && r.hi > r.lo && price != null) {
      const cur = price / 100;
      const clamped = Math.max(r.lo, Math.min(r.hi, cur));
      const pct = ((clamped - r.lo) / (r.hi - r.lo)) * 100;
      bar52 = `<div class="tile-52w" title="52W range ${_compactRupees(r.lo)} – ${_compactRupees(r.hi)} · now ${_compactRupees(cur)}">
        <span class="tile-52w-end">L</span>
        <div class="tile-52w-track"><div class="tile-52w-marker" style="left: ${pct.toFixed(1)}%"></div></div>
        <span class="tile-52w-end">H</span>
      </div>`;
    } else {
      bar52 = `<div class="tile-52w tile-52w-empty"><span class="dim">—</span></div>`;
    }
  } catch {
    bar52 = `<div class="tile-52w tile-52w-empty"><span class="dim">—</span></div>`;
  }
  const changeFpAttr = opts?.changeFp ? ` data-change-fp="${escapeAttr(opts.changeFp)}"` : "";
  return `
    <div class="tile-head">
      <div class="stock-avatar tile-avatar">${escapeHtml(inst.logo || inst.symbol.slice(0, 3))}</div>
      <div class="tile-title">
        <div class="tile-name">${escapeHtml(inst.name)}</div>
        <div class="tile-sym">${_stubSubLine(inst)}</div>
      </div>
    </div>
    <div class="stock-sparkline tile-spark"${sparkFp}>${sparkSvg}</div>
    <div class="tile-price-cell">
      ${hasLive || inst.kind === KIND_MF
        ? `<div class="stock-price tabular tile-price">${formatRupees(price)}</div>`
        : `<div class="skeleton" style="width: 60px; height: 14px;"></div>`}
    </div>
    <div class="tile-change-cell">
      <div class="stock-change ${deltaClass(change)} tile-change"${changeFpAttr}>
        ${hasLive ? `<span class="tile-change-abs">${escapeHtml(absChangeStr || "")}</span><span class="tile-change-pct">${formatPct(change, { sign: true })}</span>` : `<span class="dim">—</span>`}
      </div>
    </div>
    <div class="tile-vol-cell tabular dim" title="Today's traded volume">${escapeHtml(volStr)}</div>
    <div class="tile-52w-cell">${bar52}</div>
  `;
}

// Stock-card change-line fingerprint. Used by the patchHydratedCards
// re-render guard (read side) AND — once 21a.2/21a.3 land — by every
// caller that emits a fresh card body via renderStockCardBody (write
// side). Both sides compute identical fingerprints from identical
// inputs, so the first quote-tick after initial render becomes a
// fingerprint hit → no innerHTML rebuild → no DOM teardown → no
// flash. Mirrors the data-spark-fp contract introduced in Hotfix20a.
//
// Output format must stay byte-identical between the read and write
// paths or every first-tick will miss the guard and re-paint
// silently. Format: `${changePct.toFixed(4)}|${badgeKey}|stock-change <delta>`
function computeChangeFp(changePct, source, stale, msState) {
  const newClass = `stock-change ${deltaClass(changePct)}`;
  const badgeKey = msState !== "open"
    ? `closed:${msState}`
    : (source && source !== "mf-static" && source !== "synthetic" ? `live:${stale ? "1" : "0"}` : "syncing");
  return `${(changePct ?? 0).toFixed(4)}|${badgeKey}|${newClass}`;
}

// Mood banner inner-HTML emitter. Lives at module scope so the
// surgical mood-fetch resolution path (Hotfix27a) can call it
// without re-deriving the template inline. Empty string when mood
// is null â€” the slot div stays empty until the LLM call resolves.
// Hotfix59a: skeleton for the mood card while the LLM generates the
// narrative. Replaces the previous empty-slot path that caused the
// page to reflow when the real card popped in. Skeleton has the same
// outer dimensions + temperature-neutral border so the visual jump
// when the real mood lands is just a shimmer→prose swap, not a layout
// shift. Personal coda is a tiny client-side line appended below the
// shared narrative (computed from holdings + quoteCache, no LLM call)
// so the mood stays cacheable across users while still feeling
// personal.
function renderMoodSkeletonHtml() {
  return `<div class="market-mood-card market-mood-card-skeleton" aria-busy="true" aria-label="Loading today's mood">
    <div class="mood-head">
      <span class="pf-digest-label">Today's mood</span>
      <span class="skeleton-pill skeleton-shimmer" style="width: 56px; height: 18px;"></span>
    </div>
    <div class="mood-body">
      <div class="skeleton-line skeleton-shimmer" style="width: 92%; height: 10px; margin-bottom: 8px;"></div>
      <div class="skeleton-line skeleton-shimmer" style="width: 78%; height: 10px; margin-bottom: 8px;"></div>
      <div class="skeleton-line skeleton-shimmer" style="width: 86%; height: 10px;"></div>
    </div>
  </div>`;
}

function renderMoodHtml(mood) {
  if (!mood) return renderMoodSkeletonHtml();
  // Hotfix59a: append the user's pinch-of-personalization line. Shared
  // narrative comes from the cached server-side mood (per-IST-day +
  // sector-signature, so all users with the same broad market view get
  // the same paragraph). Personal coda is computed locally from this
  // user's holdings + the live quoteCache — no LLM call, no cache
  // invalidation, just a templated one-liner like:
  //     Your top holding RELIANCE +2.97% today.
  //     Your portfolio today: 2 up, 1 flat.
  // Falls silent when there are no holdings or no fresh quotes.
  const coda = _renderPersonalCoda();
  return `<div class="market-mood-card mood-${escapeAttr(mood.temperature)}">
    <div class="mood-head">
      <span class="pf-digest-label">Today's mood</span>
      <span class="mood-pill mood-${escapeAttr(mood.temperature)}">${escapeHtml(mood.temperature)}</span>
    </div>
    <div class="mood-body">${escapeHtml(mood.narrative)}</div>
    ${coda ? `<div class="mood-personal dim text-xs" style="margin-top: 8px;">${coda}</div>` : ""}
  </div>`;
}

// Templated, deterministic personal coda. Picks the largest current
// holding (by qty × LTP) and reports its day-change. If user has 2+
// holdings reports a quick "N up, M down, K flat" tally. No randomness,
// no LLM call, runs in <1 ms.
//
// Hotfix61a: hardened to actually fire on first paint. Was silently
// returning "" because the user's holdings weren't yet in the
// module-scoped quoteCache (which fills as cards hydrate). Now falls
// back through three sources in order:
//   1. quoteCache (live ticks from subscribeToQuotes)
//   2. getCachedQuotes (persisted localStorage from any prior session)
//   3. inst.nav for MFs / inst.price for stubs (worst-case)
// This lets the coda render immediately on cold-load with yesterday's
// persisted close — accurate enough for "your holding X +Y%" and far
// better than a missing line entirely.
//
// Hotfix62b: humanise the label. Showing "MF_151908" to a teen makes
// the page look broken — that's our internal AMFI scheme code, not a
// fund name. For mutual funds we now use inst.name with predictable
// plan/option suffixes stripped, then truncated to ~40 chars. Stocks
// and ETFs keep the ticker — RELIANCE / NIFTYBEES are the canonical
// public labels and readers know them.
function _codaLabel(sym, inst) {
  if (!sym.startsWith("MF_")) return sym;
  let label = (inst && inst.name) || sym;
  // Strip "- Direct Plan - Growth", "- Regular Plan - IDCW Payout",
  // "- Direct Plan - IDCW", etc. The plan + option pair is implied by
  // the buy flow (we only show one plan to teens) so the suffix is dead
  // weight in a one-line coda.
  label = label.replace(
    /\s*-?\s*(Direct|Regular)\s+Plan\s*-?\s*(Growth|IDCW(\s+(Payout|Reinvestment))?)?\s*$/i, ""
  );
  // Then strip a trailing "- Growth" / "-IDCW" / "- IDCW Payout" that
  // didn't have a plan word in front (common for ETF-style MFs whose
  // name reads "Mirae Asset Nifty 1D Rate Liquid ETF-IDCW").
  label = label.replace(
    /\s*-\s*(Growth|IDCW(\s+(Payout|Reinvestment))?)\s*$/i, ""
  );
  label = label.trim();
  if (!label) label = inst?.name || sym;
  if (label.length > 42) label = label.slice(0, 40).trimEnd() + "…";
  return label;
}

function _renderPersonalCoda() {
  try {
    const state = getState();
    const syms = Object.keys(state.holdings || {});
    if (!syms.length) return "";
    // Pull the persisted (localStorage-backed) quote cache as a
    // fallback for any holding the live cache hasn't observed yet.
    const persisted = getCachedQuotes(syms);
    const rows = [];
    for (const sym of syms) {
      const inst = getInstrument(sym);
      if (!inst) continue;
      const q = quoteCache[sym] || persisted[sym] || null;
      let px = q && Number.isFinite(q.pricePaise) ? q.pricePaise : null;
      let ch = q && Number.isFinite(q.changePct) ? q.changePct : null;
      // MF defensive: AMFI publishes one NAV per day, no intraday
      // motion. If we don't have a live quote, use inst.nav directly
      // so the coda still gets a price; ch defaults to 0.
      if (sym.startsWith("MF_") && (px == null || px <= 0)) {
        if (typeof inst.nav === "number" && inst.nav > 0) {
          px = Math.round(inst.nav * 100);
          if (ch == null) ch = 0;
        }
      }
      if (px == null || px <= 0 || ch == null) continue;
      const qty = state.holdings[sym]?.qty || 0;
      rows.push({ sym, inst, name: inst.name || sym, value: qty * px, ch });
    }
    if (!rows.length) return "";
    rows.sort((a, b) => b.value - a.value);
    const top = rows[0];
    const sign = top.ch >= 0 ? "+" : "";
    const pct = `${sign}${(top.ch * 100).toFixed(2)}%`;
    const label = _codaLabel(top.sym, top.inst);
    if (rows.length === 1) {
      return `Your holding <strong>${escapeHtml(label)}</strong> ${escapeHtml(pct)} today.`;
    }
    let up = 0, down = 0, flat = 0;
    for (const r of rows) {
      if (Math.abs(r.ch) < 0.001) flat++;
      else if (r.ch > 0) up++;
      else down++;
    }
    const tally = [];
    if (up)   tally.push(`${up} up`);
    if (down) tally.push(`${down} down`);
    if (flat) tally.push(`${flat} flat`);
    return `Your top holding <strong>${escapeHtml(label)}</strong> ${escapeHtml(pct)} · portfolio today: ${tally.join(", ")}.`;
  } catch {
    return "";
  }
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

// =============================================================================
// STALENESS BADGE — replaces the misleading "DELAYED" pill that was showing
// on every stock whose last NSE tick was > 90s old during market hours.
//
// User feedback (2026-05-04): "why so many delayed?". Pattern was:
//   - LIVE on liquid stocks (3M, 3i Infotech, 63 moons) — they tick every
//     few seconds during the session
//   - DELAYED on small/microcaps (3B Films, 7NR Retail, A-1 Ltd) — they
//     just don't trade every 90s. Yahoo's timestamp is the genuine NSE
//     last-trade time, not when WE fetched. So the price IS the most
//     recent available; only the wording was misleading.
//
// New rules:
//   - Quote fresh (< 90s) AND market open       →  LIVE          (green)
//   - Quote stale AND looks low-volume          →  LAST HH:MM    (neutral)
//   - Quote stale AND looks high-volume         →  LAGGING HH:MM (yellow)
//
// Low-volume heuristic: today's reported volume < 50000 shares OR the
// instrument is categorised as small/micro cap. Either signal alone is
// enough. The "LAST HH:MM" wording is neutral — accurate without implying
// our system is broken.
function _isLowVolumeStock(inst, quote) {
  const vol = quote?.volume || 0;
  if (vol > 0 && vol < 50000) return true;
  const cap = inst?.cap_bucket || inst?.capBucket || "";
  if (cap === "micro" || cap === "small") return true;
  return false;
}
function _stalenessBadge(quote, inst, opts) {
  const o = opts || {};
  const fontSize = o.size === "mini" ? "8px" : "9px";
  const padding  = o.size === "mini" ? "0 5px" : "1px 6px";
  const asOf = quote?.ts ? new Date(quote.ts).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata"
  }) : "";
  const isLowVol = _isLowVolumeStock(inst, quote);
  if (isLowVol) {
    const tip = `Low-volume stock — last trade at ${asOf} IST. Price is the most recent available; this stock just doesn't trade every minute.`;
    return `<span class="pill" style="font-size:${fontSize}; padding:${padding}; background: var(--bg-subtle); color: var(--text-dim);" title="${escapeAttr(tip)}">LAST ${asOf}</span>`;
  }
  const tip = `Upstream feed is behind. Last tick at ${asOf} IST.`;
  return `<span class="pill pill-yellow" style="font-size:${fontSize}; padding:${padding};" title="${escapeAttr(tip)}">LAGGING ${asOf}</span>`;
}
