// =============================================================================
// STOCK DETAIL — Real price + real history via marketData. Quantity selector
// for buy/sell. Panic-sell intervention before SELL executes.
// =============================================================================

import { getInstrument, ensureMfUniverseLoaded } from "../data/universe.js";
import { track } from "../features/track.js";
import { getQuote, getHistory, getMfHistory, subscribeToQuotes, quoteAge, getFundamentals, getFreshCachedQuote } from "../data/marketData.js";
import { placeLimitOrder } from "../features/limitOrders.js";
import { buildOrderBook, buildRecentTrades } from "../data/orderBook.js";
import { getSeries, getCloses, getPriceAt, getTodayChange, get52wRange, marketStatus } from "../data/prices.js";
import { candleChart, lineChart, stockChart, attachStockChartHover } from "../components/charts.js";
import { attachChartZoom, intervalForScale } from "../components/chartZoom.js";
import { formatRupees, formatPct, deltaClass, formatQty } from "../money.js";
import {
  getState, subscribe, applyTrade, recordCoachMessage, genId, addToWatchlist, removeFromWatchlist,
  getPortfolioValue,
} from "../state.js";
import { coach } from "../coach/orchestrator.js";
import { detectPanicSell } from "../coach/biasDetectors.js";
import { buildAnalogContext } from "../coach/historicalAnalog.js";
import { showInterventionModal } from "../components/interventionModal.js";
import { mountQuantitySelector } from "../components/quantitySelector.js";
import { toast } from "../components/toast.js";
import { termHtml } from "../features/aiExplainer.js";

// Timeframe → Yahoo range/interval. Granularity tuned to match Groww/
// Zerodha density at every TF the user lives in (1D, 1W, 1M).
//
// Hotfix47a: added YTD, 5Y, MAX. /api/history accepts all of these (see
// _RANGE_RE in api/history.py). User asked for long-term context that
// the previous 1Y cap blocked. Interval ladders down for longer ranges
// so we don't overload the chart with 2,500 daily candles on MAX.
//
// Hotfix62c: 1D was 5m → ~75 candles per session, looked sparse next to
// Groww/Google. Yahoo serves 1m for any range≤7d, so we get ~375 candles
// for a full session at no extra latency.
//
// Hotfix62g: 1W was 30m (~65 points across 5 days) and 1M was 1d (~22
// points across a month). User's side-by-side with Groww showed both
// were way too smooth/sparse — Groww shows minute-or-5-minute
// granularity at every multi-day TF. Yahoo serves 5m for range≤60d, so:
//   1W: 30m → 5m  (~375 points for 5 trading days)
//   1M: 1d  → 30m (~290 points for ~22 trading days)
// Same Yahoo endpoint, same latency, ~10× the visual texture. Candle
// width math floors at 1.5 px so dense bars merge into a smooth
// ribbon matching what Groww ships.
const TF_MAP = {
  "1D":  { range: "1d",  interval: "1m",  days: 1     },
  "1W":  { range: "5d",  interval: "5m",  days: 5     },
  "1M":  { range: "1mo", interval: "30m", days: 22    },
  "3M":  { range: "3mo", interval: "1d",  days: 66    },
  "6M":  { range: "6mo", interval: "1d",  days: 130   },
  "YTD": { range: "ytd", interval: "1d",  days: 260   },
  "1Y":  { range: "1y",  interval: "1d",  days: 260   },
  "5Y":  { range: "5y",  interval: "1wk", days: 260*5 },
  "MAX": { range: "max", interval: "1mo", days: 260*10},
};
const TF_ORDER = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "5Y", "MAX", "CUSTOM"];

let ui = {
  side: "BUY", qty: 1,
  timeframe: "1M",
  chartMode: "candle",   // "candle" | "area"
  orderType: "MARKET", limitPrice: 0,
  // Zoom state — only meaningful on the 1D intraday chart. scale=1 means
  // the whole session (09:15-15:30 IST) is visible. scale>1 zooms in,
  // centered on centerMs. manualPan=true once the user has explicitly
  // panned horizontally; disables the sticky-right-edge auto-follow.
  zoom: { scale: 1, centerMs: null, manualPan: false },
  // When zoomed in, overrides TF_MAP[timeframe].interval with a finer
  // granularity ("5m" default → "2m" → "1m" as scale climbs). null =
  // use the timeframe's default interval.
  interval: null,
};
let liveQuote = null;
let liveHistory = null;
let liveFundamentals = null;
let qtySelectorHandle = null;
let _cancelToken = { cancelled: false };    // shared per-mount token
let _stockWhyKey = null;                     // "SYMBOL_day" — prevents refire on live-quote refresh
let _stockWhyLast = null;                    // last explanation rendered for this mount
let _historyAbortCtrl = null;                // cancel a previous in-flight refresh
let _historyPoll = null;                     // setInterval for periodic 1D refresh
let _zoomDetach = null;                      // cleanup fn returned by attachChartZoom
let _gestureActive = false;                  // true while a zoom/pan gesture is in flight
let _prevLastDataMs = null;                  // tracked for sticky-right-edge logic in refreshHistory

async function withRequestTimeout(promiseFactory, { timeoutMs, timeoutMessage }) {
  let timer = null;
  try {
    return await Promise.race([
      promiseFactory(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Compute today's IST market session boundaries (09:15 → 15:30) as ms
// timestamps. Using an explicit "+05:30" offset string makes this work
// regardless of the user's machine timezone — pacific, eastern,
// anywhere. Returns null on holidays / weekends so the chart falls
// back to its default index-axis behaviour for previous-session data.
// 1D-with-fallback loader. The bare /api/history?range=1d returns nothing
// on weekends, market holidays, and the first ~5 minutes of the trading
// day before any candle has formed. In those cases we refetch range=5d
// interval=30m and slice to the most recent calendar-day's bars so the
// 1D tab keeps showing the *last actual trading session* — same UX Groww
// and Zerodha Kite ship. The returned object carries a `_fallbackLabel`
// when the slice is non-empty so render() can show a "Showing last
// session: 24 Apr" hint under the chart.
async function loadHistoryWithFallback(symbol, tf, interval) {
  let h = await getHistory(symbol, tf.range, interval).catch(() => null);
  if (tf !== TF_MAP["1D"]) return h;
  // Hotfix64e: getHistory() silently substitutes synthHistory() on Yahoo
  // failure (returns 365 fake daily bars), so a non-empty `h` does NOT
  // prove we got real intraday data. On weekends + holidays Yahoo's
  // /api/history?range=1d returns 502 → getHistory returns synth →
  // without rejecting synth here the 5d-slice path below never runs and
  // the chart shows year-long synthetic data labelled "1D". Reject
  // synth so the fallback fires and we paint Friday's session instead.
  if (h && h.source && h.source !== "synthetic" && h.ohlc?.length >= 2) return h;
  // Refetch wider granularity, slice to last calendar day in IST.
  const wide = await getHistory(symbol, "5d", "30m").catch(() => null);
  if (!wide?.ohlc?.length || wide.source === "synthetic") return h;   // give up — caller falls back to skeleton
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const buckets = new Map();
  for (const bar of wide.ohlc) {
    const k = fmt.format(new Date(bar.t));
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(bar);
  }
  const lastKey = [...buckets.keys()].sort().pop();
  const lastBars = lastKey ? buckets.get(lastKey) : null;
  if (!lastBars || !lastBars.length) return h;
  // Friendly date label — "24 Apr" / "12 Mar" — for the banner.
  const labelFmt = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
  });
  const label = labelFmt.format(new Date(lastBars[0].t));
  return { ...wide, ohlc: lastBars, _fallbackLabel: label };
}

function todaysMarketWindowMs() {
  const ms = marketStatus();
  // marketStatus exposes istDate, istTime, isHoliday, and istDay
  // ("mon".."sun"). For a robust IST date, derive YYYY-MM-DD via Intl
  // in IST and use the explicit offset string for parseable construction.
  //
  // Hotfix64e: was reading ms.weekday — that property doesn't exist.
  // The actual key is ms.istDay. So isWeekend was always false, weekend
  // windows leaked through to render() and the chart drew an empty
  // frame for today instead of falling back to the last trading session.
  // User: "on saturdays and sundays, the 1D graph STILL DRAWS." Now
  // weekends are treated identically to holidays — return null so the
  // render-side fallback below picks Friday's session and labels it
  // "Showing last session: 02 May".
  if (ms.isHoliday || ms.istDay === "sat" || ms.istDay === "sun") return null;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  const fromMs = new Date(`${ymd}T09:15:00+05:30`).getTime();
  const toMs   = new Date(`${ymd}T15:30:00+05:30`).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return { fromMs, toMs };
}

// Pick an SVG viewBox width that actually fits the user's viewport.
// Previously this was a hard `innerWidth < 640 ? 440 : 800` — but on a
// folded Galaxy Z Flip (~280 px viewport, ~232 px usable after card
// gutters) 440 overflows and causes horizontal clipping of axis labels
// on the right. Clamp to viewport-minus-padding with a 280 floor so
// the chart is always legible.
function computeChartWidth() {
  if (typeof window === "undefined") return 800;
  const iw = window.innerWidth;
  if (iw >= 640) return 800;
  // 48 px accounts for card padding + page gutters (≈ 2 × var(--sp-3)).
  return Math.max(280, Math.min(440, iw - 48));
}

export function renderStockDetail(main, params) {
  const symbol = params.symbol;
  const inst = getInstrument(symbol);
  // Throttled to one row per symbol per minute in track.js, so a
  // re-render or a quick back-and-forth does not inflate the count.
  track("stock_view", symbol, { sector: inst?.sector || null, kind: inst?.kind || null });
  // Reset the per-mount AI-why memo whenever the viewed symbol changes.
  if (_stockWhyKey && !_stockWhyKey.startsWith(symbol + "_")) {
    _stockWhyKey = null;
    _stockWhyLast = null;
  }
  if (!inst) {
    main.innerHTML = `<div class="empty-state"><span class="emoji">🔍</span><h3>Instrument not found</h3><p>Symbol "${symbol}" isn't in the universe.</p><a href="#/stocks" class="btn btn-primary">Back</a></div>`;
    return;
  }

  // Cancel any previous mount's pending work
  _cancelToken.cancelled = true;
  _cancelToken = { cancelled: false };
  const myToken = _cancelToken;

  // Hotfix52a: on hard-reload of an MF detail URL, the mfFull.json
  // bundle may not be loaded yet â€” getInstrument returns a bare stub
  // with no nav, no name, no AMC. The header price would fall through
  // to the synthetic walk-anchor (Rs.4,286 for MF_100033 etc.) and the
  // title would show the raw 'MF_100033' code. Kick the MF universe
  // load and re-render with the real instrument data when it resolves.
  if (symbol.startsWith("MF_") && (!inst.name || inst.name === symbol || typeof inst.nav !== "number")) {
    ensureMfUniverseLoaded().then(() => {
      if (myToken.cancelled) return;
      const fresh = getInstrument(symbol);
      if (fresh && fresh.name && fresh.name !== symbol) {
        // Hotfix53b: also reassign activeInst so the periodic polls
        // below (subscribe + subscribeToQuotes) re-render with the
        // fresh inst on subsequent ticks. Without this the title
        // flipped back to 'MF_100037' every 12 seconds when the poll
        // re-rendered with the stale bare-stub.
        activeInst = fresh;
        render(activeInst, symbol);
      }
    }).catch(() => {});
  }

  ui = {
    side: "BUY",
    qty: inst.kind === "MF" ? 0.5 : 1,
    timeframe: "1M",
    chartMode: "candle",
    orderType: "MARKET", limitPrice: 0,
    zoom: { scale: 1, centerMs: null, manualPan: false },
    interval: null,
  };
  _prevLastDataMs = null;
  _gestureActive = false;
  liveQuote = null;
  liveHistory = null;
  liveFundamentals = null;
  qtySelectorHandle?.destroy?.();
  qtySelectorHandle = null;

  // Prefill liveQuote ONLY if the cache entry is fresh. This avoids the
  // "flash of stale price" bug where the page used to paint inst.price
  // (the seeded universe price, possibly months old) for 5-15 seconds
  // before the first poll landed. Fresh cache → instant paint with real
  // prices. No fresh cache → render() falls through to the price-block
  // skeleton and waits for the poll.
  const preQuote = inst.kind !== "MF" ? getFreshCachedQuote(symbol) : null;
  if (preQuote) liveQuote = preQuote;

  // Hotfix53b: mutable instance reference. The subscribe/poll callbacks
  // below close over this variable by reference, so when Hotfix52a's
  // ensureMfUniverseLoaded resolves and assigns a fresh inst, every
  // subsequent render() call (state ticks, 12s quote polls, history
  // poll) picks up the new instrument. Without this, the polling cycle
  // re-rendered with the stale bare-stub inst every 12s and reverted
  // the title back to 'MF_100037'.
  let activeInst = inst;
  render(activeInst, symbol);
  // Guard: any render() call during an in-flight zoom/pan gesture replaces
  // main.innerHTML and wipes the SVG mid-gesture. Defer until the next
  // tick lands after the gesture ends. render() is idempotent so skipping
  // a single tick produces no user-visible side-effect other than a
  // slightly-staler-by-12s price that auto-heals on the next tick.
  const unsub = subscribe(() => {
    if (myToken.cancelled || _gestureActive) return;
    render(activeInst, symbol);
  });
  const pollUnsub = subscribeToQuotes([symbol], (quotes) => {
    if (myToken.cancelled) return;
    if (quotes[symbol]) {
      liveQuote = quotes[symbol];
      if (_gestureActive) return;    // defer render until gesture ends
      render(activeInst, symbol);
    }
  }, 12_000);  // 12s refresh on the currently-open stock
  const onLeave = () => {
    myToken.cancelled = true;
    unsub?.();
    pollUnsub?.();
    if (_historyPoll) { clearInterval(_historyPoll); _historyPoll = null; }
    if (_historyAbortCtrl) { try { _historyAbortCtrl.abort(); } catch {} _historyAbortCtrl = null; }
    if (_zoomDetach) { _zoomDetach(); _zoomDetach = null; }
    _gestureActive = false;
  };
  window.addEventListener("hashchange", onLeave, { once: true });
  // Fetch history
  (async () => {
    try {
      const tf = TF_MAP[ui.timeframe] || TF_MAP["1M"];
      // Honour ui.interval if the user has zoomed in (overrides the
      // timeframe's default granularity with a finer one, e.g. "1m").
      const interval = ui.interval ?? tf.interval;
      // MF branch — real NAV history from mfapi.in via /api/mf-history.
      // Equities + ETFs go through the Yahoo path with 1D-fallback to last
      // trading session on weekends/holidays/pre-market.
      const h = inst.kind === "MF"
        ? await getMfHistory(symbol, ui.timeframe)
        : await loadHistoryWithFallback(symbol, tf, interval);
      if (myToken.cancelled) return;
      if (h) {
        liveHistory = h;
        if (h.ohlc?.length) _prevLastDataMs = h.ohlc[h.ohlc.length - 1].t;
        render(inst, symbol);
      }
    } catch (e) { console.warn("history:", e); }
  })();

  // For 1D intraday, poll history every 30 s during market hours so new
  // 5-min candles appear without a page reload. Uses refreshHistory()
  // (NOT reloadHistory) so liveHistory is never null'd mid-render —
  // that would flash the skeleton every 30s, which is worse UX than
  // staleness. AbortController prevents in-flight pile-ups when polls
  // overlap.
  startHistoryPoll(inst, symbol);

  // Fetch fundamentals. This was missing — liveFundamentals was declared
  // but never populated, so the Fundamentals card sat on "Loading…" forever
  // and fell back to universe.js static values + synthetic 52W range.
  (async () => {
    try {
      if (inst.kind === "MF") return;   // MFs don't have per-share fundamentals
      const f = await getFundamentals(symbol);
      if (myToken.cancelled) return;
      if (f) {
        liveFundamentals = f;
        render(inst, symbol);
        // Re-attempt the deferred STOCK_INTRO now that PE/MarketCap are
        // available — without this, intros for any stock that was opened
        // before fundamentals landed would never fire.
        maybeFireStockIntro();
      }
    } catch (e) { console.warn("fundamentals:", e); }
  })();

  // Stock intro coach (non-blocking, first view only).
  // Per Landing F: hand-typed inst.pe / inst.marketCap fields are gone
  // from the universe shape. The intro template reads instrument data to
  // generate "{NAME} is a {SECTOR} company. P/E is {pe}, ..." — so when
  // the live fundamentals haven't landed yet OR the sector is unknown
  // ("Other") we DEFER the intro until /api/fundamentals returns. Without
  // this guard the coach feed gets permanently polluted with
  // "RELIANCE is a Other company. P/E is —" gibberish that survives
  // localStorage reloads.
  const existing = getState().coachMessages.some(m => m.eventType === "STOCK_INTRO" && m.triggerSymbol === symbol);
  function maybeFireStockIntro() {
    if (existing || inst._stub) return;
    if (inst.kind === "MF") {
      // MFs don't have PE/sector — fire with a different template path.
      coach({ type: "STOCK_INTRO", symbol, instrument: inst }).then(msg => {
        if (myToken.cancelled) return;
        msg.triggerSymbol = symbol;
        recordCoachMessage(msg);
      });
      return;
    }
    // Equity / ETF: require both a real sector AND live fundamentals
    // (PE in particular — the intro template references it). If either
    // is missing, defer; the fundamentals fetch above will retrigger
    // render() once data lands and we'll come through here again.
    // Prefer the live Tickertape sector over the universe sector — Tickertape
    // ships the GIC sector ("Financials", "Consumer Staples", "Energy") which
    // is more accurate and up-to-date than build-universe.mjs's sector
    // assignment ("Banking", "Food", etc. derived from NSE Industry overlay).
    // E.g. HDFCBANK universe="Banking" but Tickertape says "Financials";
    // ADFFOODS universe="Food" but Tickertape says "Consumer Staples".
    const liveSector = liveFundamentals?.sector || inst.sector;
    const hasSector = liveSector && liveSector !== "Other" && liveSector !== "Unknown";
    const hasPE = liveFundamentals?.pe_ratio != null;
    if (!hasSector || !hasPE) return;
    coach({
      type: "STOCK_INTRO",
      symbol,
      instrument: {
        ...inst,
        pe: liveFundamentals.pe_ratio,
        marketCap: liveFundamentals.market_cap,
        sector: liveSector,   // override stale universe sector
      }
    }).then(msg => {
      if (myToken.cancelled) return;
      msg.triggerSymbol = symbol;
      recordCoachMessage(msg);
    });
  }
  maybeFireStockIntro();
}

// Reload — used on TF change. Nulls liveHistory first so the skeleton
// shows while the new TF loads (intentional UX — switching TF is an
// explicit action so the user expects to wait).
async function reloadHistory(inst, symbol) {
  const myToken = _cancelToken;
  const tf = TF_MAP[ui.timeframe] || TF_MAP["1M"];
  const interval = ui.interval ?? tf.interval;
  liveHistory = null;
  // Clear sticky-edge baseline — the next fetch belongs to a different
  // (timeframe, interval) combo, and comparing timestamps across those
  // would produce nonsense sticky-shift math.
  _prevLastDataMs = null;
  render(inst, symbol);
  // Hotfix48b: CUSTOM range fetch path. Sends from/to dates to the
  // backend instead of a preset range. Picks an interval based on the
  // span: <1y -> 1d, 1-5y -> 1wk, >5y -> 1mo. MFs don't support custom
  // ranges yet (mfapi.in's API only takes preset tfs); MF + CUSTOM
  // falls back to ALL.
  let h;
  if (ui.timeframe === "CUSTOM" && ui.customFrom && ui.customTo) {
    if (inst.kind === "MF") {
      h = await getMfHistory(symbol, "ALL").catch(() => null);
    } else {
      const dayMs = 86400000;
      const span = (new Date(ui.customTo) - new Date(ui.customFrom)) / dayMs;
      const customInterval = span < 365 ? "1d" : span < 5 * 365 ? "1wk" : "1mo";
      h = await getHistory(symbol, "1y", customInterval, {
        from: ui.customFrom, to: ui.customTo,
      }).catch(() => null);
    }
  } else if (inst.kind === "MF") {
    h = await getMfHistory(symbol, ui.timeframe).catch(() => null);
  } else {
    h = await loadHistoryWithFallback(symbol, tf, interval).catch(() => null);
  }
  if (myToken.cancelled) return;
  if (h) {
    liveHistory = h;
    if (h.ohlc?.length) _prevLastDataMs = h.ohlc[h.ohlc.length - 1].t;
    render(inst, symbol);
  }
}

// Refresh — used by the 30-second 1D poll. Does NOT null liveHistory
// (no skeleton flash); the new fetch silently replaces the old data
// and the next render paints the additional candle. AbortController
// cancels any previous in-flight refresh so slow responses can't
// overwrite a fresher one.
//
// CRITICAL: noCache:true. getHistory has a 10-minute in-memory cache
// (HISTORY_TTL_MS) so a naive poll would return the same ohlc array
// 20 times in a row between 11:00 and 11:10 IST — defeating the entire
// point of polling. Passing noCache forces the underlying /api/history
// fetch each tick, picking up newly-closed 5-min candles as they land.
// The server-side cache (Vercel edge + upstream Yahoo's own caching)
// still absorbs the load; only OUR in-memory cache is bypassed here.
async function refreshHistory(inst, symbol) {
  const myToken = _cancelToken;
  // Defer the refresh if the user is in the middle of a zoom/pan gesture.
  // Replacing main.innerHTML mid-gesture would wipe the in-flight SVG
  // transform and break the pinch halfway. The next 30-s tick picks it up.
  if (_gestureActive) return;
  if (_historyAbortCtrl) { try { _historyAbortCtrl.abort(); } catch {} }
  _historyAbortCtrl = new AbortController();
  const sig = _historyAbortCtrl.signal;
  try {
    const tf = TF_MAP[ui.timeframe] || TF_MAP["1M"];
    // Honour ui.interval if the user has zoomed in. The Vercel edge cache
    // on /api/history keys per (symbol, range, interval) so switching
    // intervals gets a distinct cache entry, not a stale hit.
    const interval = ui.interval ?? tf.interval;
    const h = await getHistory(symbol, tf.range, interval, { signal: sig, noCache: true });
    if (sig.aborted || myToken.cancelled) return;
    if (h?.ohlc?.length) {
      // Sticky-right-edge: if we are zoomed in AND the user has not
      // explicitly panned, shift centerMs forward by the delta between
      // the new latest candle and the old one so the zoomed window
      // keeps tracking live. Detection: the rightmost visible edge
      // before this refresh must have been at/past the prev lastDataMs
      // (the user was watching live). Otherwise freeze the window
      // (user panned left at some point without flipping manualPan).
      const prevLast = _prevLastDataMs;
      const newLast = h.ohlc[h.ohlc.length - 1].t;
      if (
        ui.timeframe === "1D"
        && ui.zoom.scale > 1
        && !ui.zoom.manualPan
        && Number.isFinite(prevLast)
        && Number.isFinite(newLast)
        && newLast > prevLast
        && ui.zoom.centerMs != null
      ) {
        // Was the previous visible right edge at or past prevLast?
        const win = todaysMarketWindowMs();
        if (win) {
          const totalSpan = win.toMs - win.fromMs;
          const prevSpan = totalSpan / ui.zoom.scale;
          const prevRightEdge = ui.zoom.centerMs + prevSpan / 2;
          if (prevRightEdge >= prevLast - 1000) {
            // User was watching live — scoot centerMs forward to follow.
            ui.zoom.centerMs += (newLast - prevLast);
          }
        }
      }
      _prevLastDataMs = newLast;
      liveHistory = h;
      render(inst, symbol);
    }
  } catch (e) {
    if (e?.name !== "AbortError") console.warn("[refreshHistory]", e?.message || e);
  }
}

// Apply a zoom commit from chartZoom.js. Called on wheel-stop / pinch-end
// / pan-end. Updates ui.zoom state (which the next render uses to narrow
// xAxisRange), and on 1D ALSO swaps ui.interval if the zoom level crosses
// a granularity threshold (5m → 2m → 1m) and re-fetches. Works on every
// timeframe now — non-1D TFs just narrow the visible window without
// changing interval (Yahoo's constraints make per-TF interval ladders
// fiddly; users still get meaningful zoom behaviour).
async function applyZoomCommit(inst, symbol, next) {
  const newScale = next.scale;
  const newCenter = next.centerMs;
  const newManualPan = next.manualPan;

  // Persist state first so render() sees the new zoom.
  ui.zoom = { scale: newScale, centerMs: newCenter, manualPan: newManualPan };

  // Granularity ladder is 1D-only. On other timeframes the interval
  // stays at TF_MAP[timeframe].interval; zoom just narrows the visible
  // window over the existing candles, with Y-axis auto-fit doing the
  // heavy lifting for visible-price-range refinement.
  if (ui.timeframe === "1D") {
    const newInterval = intervalForScale(newScale);
    const curInterval = ui.interval ?? (TF_MAP["1D"]?.interval ?? "1m");
    const intervalChanged = newInterval !== curInterval;
    ui.interval = (newScale <= 1) ? null : newInterval;

    if (intervalChanged) {
      // Fire a fresh fetch for the new granularity. No skeleton flash —
      // reuse refreshHistory's "update in place" semantics. If the
      // fetch is slow the old candles stay visible until it lands.
      const myToken = _cancelToken;
      if (_historyAbortCtrl) { try { _historyAbortCtrl.abort(); } catch {} }
      _historyAbortCtrl = new AbortController();
      const sig = _historyAbortCtrl.signal;
      try {
        const tf = TF_MAP["1D"];
        const h = await getHistory(symbol, tf.range, newInterval, { signal: sig });
        if (sig.aborted || myToken.cancelled) return;
        if (h?.ohlc?.length) {
          liveHistory = h;
          _prevLastDataMs = h.ohlc[h.ohlc.length - 1].t;
        }
      } catch (e) {
        if (e?.name !== "AbortError") console.warn("[applyZoomCommit]", e?.message || e);
      }
    }
  }
  render(inst, symbol);
}

// Reset zoom back to full session 1x. Dropped back to TF_MAP default
// interval (1m post-Hotfix62c) so the user sees the same "stable"
// view they started with.
function resetZoom(inst, symbol) {
  if (ui.zoom.scale === 1 && ui.interval == null) return;   // already reset
  ui.zoom = { scale: 1, centerMs: null, manualPan: false };
  ui.interval = null;
  // Refetch at the coarser interval — reuse reloadHistory so the
  // skeleton flashes briefly (acceptable for an explicit user action).
  reloadHistory(inst, symbol);
}

// Start (or restart) the 30-second 1D refresh poll. Idempotent — clears
// the previous interval first so calling twice doesn't double-fire.
function startHistoryPoll(inst, symbol) {
  if (_historyPoll) clearInterval(_historyPoll);
  _historyPoll = setInterval(() => {
    if (_cancelToken.cancelled) return;
    if (ui.timeframe !== "1D") return;
    if (!marketStatus().open) return;
    refreshHistory(inst, symbol);
  }, 30_000);
}

function render(inst, symbol) {
  // Guard: external render triggers (state subscribe, quote polling,
  // fundamentals fetch) are no-ops while a zoom/pan gesture is in flight.
  // Re-rendering mid-gesture would replace main.innerHTML, destroying the
  // SVG and wiping the Layer-A transform the gesture engine is managing.
  // applyZoomCommit's own render() sails through because commitNow()
  // calls setGestureActive(false) BEFORE invoking onCommit. Quote ticks
  // that land during a gesture are implicitly recovered on the next 12 s
  // tick after gesture-end — liveQuote is updated in place regardless.
  if (_gestureActive) return;
  const main = document.getElementById("main");
  const state = getState();
  const holding = state.holdings[symbol];

  // Price-block loading state. Mutual funds don't have a live feed so we
  // never show a skeleton for them. Equities: show a skeleton until the
  // first live (or fresh-cache-prefilled) quote lands — better than
  // flashing the seeded universe price for 5-15 seconds while the poll
  // ticks over.
  const priceLoading = inst.kind !== "MF" && !liveQuote;
  const curPrice = liveQuote?.pricePaise ?? getPriceAt(symbol, 0);
  const change = liveQuote?.changePct ?? getTodayChange(symbol);
  const dayChangeVal = Math.round(curPrice * change);

  const tfSpec = TF_MAP[ui.timeframe] || TF_MAP["1M"];
  // Pre-Hotfix5: historyLoading was forced to false for MFs because there
  // was no MF history fetch — the chart immediately rendered the synthetic
  // stub-walk. Now that getMfHistory() actually fetches real NAV history
  // from /api/mf-history, MFs need the same skeleton-until-resolved
  // behaviour as equities.
  const historyLoading = !liveHistory;
  const history = liveHistory?.ohlc?.length ? liveHistory.ohlc : getSeries(symbol).slice(-tfSpec.days);

  // Merge liveQuote into the last candle so the chart's newest tick matches
  // the header price. Previously the header updated every 12 s from
  // subscribeToQuotes while the chart's last candle close only updated
  // every 30 s when refreshHistory polled — at 11:36 IST the header could
  // read ₹1365.20 while the 11:30 candle still showed its close of
  // ₹1362.80 until a new candle landed. Demo-day foot-gun.
  //
  // Non-mutating derivation: mutating liveHistory.ohlc[N-1] would fight
  // the 30 s refreshHistory poll, which replaces liveHistory with a
  // fresh object from getHistory and would silently reset any in-place
  // write. Deriving a fresh array inside render() runs on every quote
  // tick AND every poll landing — both paths produce a chart that
  // agrees with the header at render time.
  //
  // Applied on EVERY non-MF timeframe now (was 1D-only): on 1W/1M/etc.
  // the last 30m / daily candle also becomes live-ticking, so the
  // "header vs chart" invariant holds regardless of the selected TF.
  // The earlier concern about Y-axis reflow on daily candles is now
  // moot — Y-auto-fit operates on the visible window only, so a 0.1%
  // tick on a month-scale view is invisible, and on a heavy zoom the
  // same tick would show on 1D too (fundamental zoom behaviour).
  let chartOhlc = history;
  if (liveQuote?.pricePaise && history.length && inst.kind !== "MF") {
    const last = history[history.length - 1];
    const lp = liveQuote.pricePaise;
    chartOhlc = history.slice(0, -1).concat([{
      ...last,
      c: lp,
      h: Math.max(last.h, lp),
      l: Math.min(last.l, lp),
    }]);
  }
  const closes = chartOhlc.map(k => k.c);

  // sessionWindow — the "full bounds" the zoom gesture engine operates on.
  // Computed for every timeframe so zoom works everywhere, not just 1D:
  //
  //   1D in-window: 09:15 → 15:30 IST today (intraday market hours).
  //                 Chart ALWAYS uses time-axis here so the chart draws
  //                 left→right as the day progresses.
  //   1D out-of-window / weekend / holiday: null — no zoom.
  //   Non-1D (1W/1M/3M/6M/1Y): data-bounded. Covers the first-to-last
  //                 candle's timestamps. Chart uses its original
  //                 index-based mapping at scale=1 (cleaner — no
  //                 overnight / weekend gaps to confuse the user), and
  //                 switches to time-axis only when the user actually
  //                 zooms in.
  let chartXAxisRange = null;
  let sessionWindow = null;
  // Hotfix50c: MF charts now opt into the data-bounded sessionWindow path
  // (was gated behind 'inst.kind !== "MF"'). Zoom + crosshair use the
  // first-to-last candle timestamps, identical to non-1D stocks. AMFI has
  // no intraday so the 1D-time-axis special-case stays equity-only.
  if (inst.kind !== "MF" && ui.timeframe === "1D") {
    const win = todaysMarketWindowMs();
    if (win) {
      // Hotfix64e: isWeekend check removed — todaysMarketWindowMs now
      // returns null on weekends/holidays, so reaching this branch
      // means it's a valid trading day. POST_CLOSE_GRACE_MS keeps the
      // window pinned through 16:00 IST so end-of-day viewers don't
      // see the chart snap to a 5d index axis at the bell.
      const POST_CLOSE_GRACE_MS = 30 * 60 * 1000;
      const inWindow = Date.now() < (win.toMs + POST_CLOSE_GRACE_MS);
      if (inWindow) {
        sessionWindow = { fromMs: win.fromMs, toMs: win.toMs };
      }
    }
    // 1D fallback to last trading session — sessionWindow comes from the
    // actual data range so zoom + crosshair still operate against real
    // candle timestamps. _fallbackLabel is set inside loadHistoryWithFallback.
    if (!sessionWindow && liveHistory?._fallbackLabel && chartOhlc.length >= 2) {
      sessionWindow = {
        fromMs: chartOhlc[0].t,
        toMs: chartOhlc[chartOhlc.length - 1].t,
      };
    }
  } else if (chartOhlc.length >= 2) {
    // Data-bounded window for non-1D stocks AND for ALL MF timeframes.
    // chartOhlc is the live-injected array so the window right-edge
    // tracks the latest candle.
    sessionWindow = {
      fromMs: chartOhlc[0].t,
      toMs: chartOhlc[chartOhlc.length - 1].t,
    };
  }

  // chartXAxisRange — what gets passed to stockChart, controlling the
  // visible time window. Decides between time-axis and index-axis rendering:
  //   1D in-window: ALWAYS time-axis (even at scale=1, so the session
  //                 frame shows 09:15→15:30 regardless of elapsed time).
  //   Non-1D scale=1: null → index-axis (cleaner multi-day view).
  //   Any scale > 1: time-axis shrunk to the zoom window.
  if (sessionWindow) {
    const mustUseTimeAxis = (ui.timeframe === "1D") || (ui.zoom.scale > 1);
    if (mustUseTimeAxis) {
      if (ui.zoom.scale <= 1) {
        chartXAxisRange = { fromMs: sessionWindow.fromMs, toMs: sessionWindow.toMs };
      } else {
        const totalSpan = sessionWindow.toMs - sessionWindow.fromMs;
        const span = totalSpan / ui.zoom.scale;
        let center = ui.zoom.centerMs ?? (sessionWindow.fromMs + totalSpan / 2);
        let vFrom = center - span / 2;
        let vTo   = center + span / 2;
        if (vFrom < sessionWindow.fromMs) { vTo += (sessionWindow.fromMs - vFrom); vFrom = sessionWindow.fromMs; }
        if (vTo > sessionWindow.toMs)     { vFrom -= (vTo - sessionWindow.toMs); vTo = sessionWindow.toMs; }
        chartXAxisRange = { fromMs: vFrom, toMs: vTo };
      }
    }
  }

  const { hi, lo } = get52wRange(symbol);
  const isWatched = state.watchlist.includes(symbol);

  const dataSource = liveQuote?.source === "yahoo" || liveQuote?.source === "finnhub"
    ? { label: "Live", live: true }
    : { label: "Cached", live: false };
  const ms = marketStatus();

  // ===================================================================
  // After-hours AMO mode — mirror Groww.
  // When NSE is closed, Market orders are disabled. The trade form
  // forces the Limit tab (== AMO) and pre-fills with the last-shown
  // price so the user can one-tap queue an order that fills at the
  // next market open. This also bypasses the apply_trade RPC hang that
  // happens out-of-hours by routing through placeLimitOrder() instead.
  //
  // SKIP for MFs — they don't trade on NSE, AMO is meaningless. MFs
  // execute at end-of-day NAV regardless of when the order is placed
  // (with cutoff-based same-day vs next-day NAV allocation handled in
  // the MF-specific Invest UX, not the equity AMO flow). Pre-fix the
  // MF detail page showed a misleading "NSE Closed — AMO mode" banner
  // 21 hours of every day, with NaN limit price.
  // ===================================================================
  if (!ms.open && inst.kind !== "MF") {
    if (ui.orderType !== "LIMIT") ui.orderType = "LIMIT";
    // Only pre-fill from a real live quote. Pre-fix: when liveQuote was
    // null at first render (typical for the first 1–10 s on cold load),
    // curPrice fell back to getPriceAt() → prices.js synthetic walk:
    //   anchor = 5000 + (seedFromString(symbol) % 500000)
    // For MTNL that resolves to 162910 paise → ₹1629.10 even though
    // the actual close was ₹30.61. The synthetic value got pinned to
    // ui.limitPrice and the gate `!ui.limitPrice || <=0` prevented any
    // re-sync once liveQuote arrived. Auto-resync stops once user
    // edits (ui._limitDirty, set in the input handler).
    if (liveQuote && !ui._limitDirty) {
      ui.limitPrice = (curPrice / 100).toFixed(2);
    }
  }

  main.innerHTML = `
    <div style="margin-bottom: var(--sp-5);">
      <div class="flex items-center gap-2">
        <a href="#/stocks" class="btn btn-ghost btn-sm">← Markets</a>
        <span class="dim">/</span>
        <span class="dim text-sm">${escapeHtml(inst.sector || "—")}</span>
      </div>
    </div>

    <div class="stock-detail-grid">
      <div>
        <div class="flex items-start justify-between wrap gap-3">
          <div class="flex items-center gap-3">
            <div class="stock-avatar" style="width: 52px; height: 52px; font-size: 13px;">${escapeHtml(inst.logo || symbol.slice(0, 3))}</div>
            <div>
              <h1 style="font-size: var(--text-2xl); margin-bottom: 2px;">${escapeHtml(inst.name || symbol)}</h1>
              <div class="dim text-xs">
                ${symbol} · ${inst.kind === "MF" ? "Mutual Fund" : "NSE"} · ${escapeHtml(inst.sector || "—")}
                <span class="data-badge market-status" tabindex="0" style="margin-left: 8px; position: relative;" data-ms-state="${ms.state}">
                  <span class="dot ${ms.open ? "" : ms.state === "pre-open" ? "preopen" : "closed"}"></span>
                  NSE · ${ms.state === "open" ? "Live" : ms.state === "pre-open" ? "Pre-open" : "Closed"}${ms.state !== "open" ? " · " + escapeHtml(ms.istTime) : ""}
                  <div class="market-status-pop" role="tooltip">
                    <div class="ms-pop-head">
                      <span class="ms-pop-label">NSE · ${ms.state === "open" ? "Live" : ms.state === "pre-open" ? "Pre-open" : "Closed"}</span>
                    </div>
                    <div class="ms-pop-row"><span class="ms-pop-key">Now</span><span>${escapeHtml(ms.istDate)} · ${escapeHtml(ms.istTime)}</span></div>
                    ${ms.state === "open"
                      ? `<div class="ms-pop-row"><span class="ms-pop-key">Closes</span><span>3:30 PM IST today</span></div>`
                      : `<div class="ms-pop-row"><span class="ms-pop-key">${ms.state === "pre-open" ? "Opens" : "Last close"}</span><span>${ms.state === "pre-open" ? "9:15 AM IST today" : escapeHtml(ms.lastCloseLabel || "—")}</span></div>`
                    }
                    ${ms.state !== "open" && ms.nextOpenLabel ? `<div class="ms-pop-row"><span class="ms-pop-key">Next open</span><span>${escapeHtml(ms.nextOpenLabel)}</span></div>` : ""}
                    ${ms.isHoliday ? `<div class="ms-pop-row"><span class="ms-pop-key">Holiday</span><span>Yes</span></div>` : ""}
                    <div class="ms-pop-row"><span class="ms-pop-key">Hours</span><span>Mon–Fri · 9:15 AM – 3:30 PM IST</span></div>
                    <div class="ms-pop-foot">Clock is server-trusted. Changing your system time won't move it.</div>
                  </div>
                </span>
              </div>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm watch-btn">${isWatched ? "★ Watching" : "☆ Watchlist"}</button>
        </div>

        <div class="price-block" style="margin-top: var(--sp-4);">
          ${priceLoading ? `
            <div class="skeleton" style="width: 180px; height: 40px;" aria-label="Loading price"></div>
            <div class="skeleton" style="width: 200px; height: 18px;" aria-label="Loading change"></div>
          ` : `
            <div class="price tabular">${formatRupees(curPrice)}</div>
            <div class="change ${deltaClass(change)} tabular">
              ${formatRupees(dayChangeVal, { sign: true })} (${formatPct(change, { sign: true })}) today
            </div>
            ${renderPriceFreshness(liveQuote)}
          `}
        </div>

        <div class="tf-buttons" style="display:flex; align-items:center; gap:var(--sp-2); flex-wrap:wrap;">
          <div style="display:flex; gap:4px; flex-wrap: wrap;">
            ${TF_ORDER.map(tf => {
              // Hotfix48b: render the CUSTOM button with a different
              // label so it reads as a control, not a preset window.
              // Click opens the date-range picker (handled below).
              const label = tf === "CUSTOM"
                ? (ui.timeframe === "CUSTOM" && ui.customFrom && ui.customTo
                    ? `${ui.customFrom} → ${ui.customTo}`
                    : "Custom…")
                : tf;
              return `<button class="tf-btn ${ui.timeframe === tf ? "active" : ""}" data-tf="${tf}">${label}</button>`;
            }).join("")}
          </div>
          ${ui.zoom.scale > 1 ? `
            <button class="btn btn-ghost btn-sm" id="zoom-reset-btn" title="Reset chart zoom" style="font-size: 11px; padding: 4px 10px;">↻ Reset zoom (${ui.zoom.scale.toFixed(1)}×${ui.interval ? ` · ${ui.interval}` : ""})</button>
          ` : ""}
          ${!isTerminatedFund(inst).terminated ? `
            <div class="chart-mode-toggle" style="margin-left:auto; display:flex; gap:2px; background:var(--bg-soft); border:1px solid var(--border); border-radius:var(--r-sm); padding:2px;">
              <button class="chart-mode-btn ${ui.chartMode === "candle" ? "active" : ""}" data-mode="candle" aria-label="Candlestick" title="Candlestick view" style="border:0; background:${ui.chartMode === "candle" ? "var(--surface)" : "transparent"}; color:${ui.chartMode === "candle" ? "var(--text-strong)" : "var(--text-muted)"}; padding:4px 10px; border-radius:calc(var(--r-sm) - 2px); cursor:pointer; font-size:var(--text-xs); display:flex; align-items:center; gap:4px;">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="3" y="3" width="2" height="8" fill="currentColor" opacity="0.9"/><line x1="4" y1="1" x2="4" y2="13" stroke="currentColor" stroke-width="1"/><rect x="9" y="5" width="2" height="5" fill="currentColor" opacity="0.9"/><line x1="10" y1="3" x2="10" y2="12" stroke="currentColor" stroke-width="1"/></svg>
                Candle
              </button>
              <button class="chart-mode-btn ${ui.chartMode === "area" ? "active" : ""}" data-mode="area" aria-label="Area line" title="Area / line view" style="border:0; background:${ui.chartMode === "area" ? "var(--surface)" : "transparent"}; color:${ui.chartMode === "area" ? "var(--text-strong)" : "var(--text-muted)"}; padding:4px 10px; border-radius:calc(var(--r-sm) - 2px); cursor:pointer; font-size:var(--text-xs); display:flex; align-items:center; gap:4px;">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1 10 L4 6 L7 8 L10 3 L13 5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>
                Line
              </button>
            </div>
          ` : ""}
        </div>

        <div class="card" style="padding: var(--sp-3);">
          ${historyLoading ? `
            <div id="stock-chart-host" style="height: clamp(260px, 44vh, 360px); width: 100%; display:grid; place-items:center; gap:var(--sp-3);">
              <div class="skeleton" style="width: 100%; height: 75%;" aria-label="Loading chart"></div>
              <div class="dim text-xs">Loading ${ui.timeframe} chart…</div>
            </div>
          ` : inst.kind === "MF"
            ? (isTerminatedFund(inst).terminated
                ? `<div style="height: 300px; display: grid; place-items: center; gap: var(--sp-2); padding: var(--sp-4); text-align: center;">
                     <div style="font-size: 32px; opacity: 0.5;">â³</div>
                     <h3 style="margin: 0; font-size: var(--text-base);">Scheme wound up</h3>
                     <div class="dim text-sm" style="max-width: 380px;">
                       AMFI hasn't published a NAV for this fund since
                       <strong>${escapeHtml(inst.nav_date || "the maturity date")}</strong>.
                       The chart isn't shown because there's no recent
                       data â€” showing a flatline at â‚¹0 would be misleading.
                     </div>
                   </div>`
                : _renderMfChartSafe(chartOhlc, ui, computeChartWidth(), chartXAxisRange))
            : `<div id="stock-chart-host" style="height: clamp(260px, 44vh, 360px); width: 100%;">${stockChart(chartOhlc, { height: 360, mode: ui.chartMode, width: computeChartWidth(), xAxisRange: chartXAxisRange })}</div>`}
          ${liveHistory?._fallbackLabel && ui.timeframe === "1D" ? `
            <div class="dim text-xs" style="margin-top: 6px; padding: 4px 8px; background: var(--bg-soft); border-radius: var(--r-sm); display: inline-flex; align-items: center; gap: 6px;">
              <span aria-hidden="true">📅</span>
              Showing last session: ${escapeHtml(liveHistory._fallbackLabel)}
              <span class="dim">· NSE was closed today</span>
            </div>
          ` : ""}
        </div>

        <div class="card stock-why-card" id="stock-why-card" style="margin-top: var(--sp-4);">
          <div class="card-head">
            <h3><span class="pf-digest-label">Saathi</span> Why is this moving today?</h3>
          </div>
          <div id="stock-why-body" class="muted">Reading today's news + price action…</div>
        </div>

        ${inst.kind !== "MF" ? renderOrderBook(symbol, curPrice) : ""}

        <div class="card" style="margin-top: var(--sp-4);">
          <div class="card-head">
            <h3>Fundamentals</h3>
            ${liveFundamentals ? `<span class="data-badge"><span class="dot"></span> NSE</span>` : `<span class="data-badge"><span class="dot offline"></span> Loading…</span>`}
          </div>
          ${liveFundamentals && inst.kind !== "MF"
            && (liveFundamentals.market_cap == null
                || liveFundamentals.pe_ratio == null
                || liveFundamentals.pb_ratio == null) ? `
            <!-- Show banner if ANY of the three core ratios is missing —
                 not just when ALL three are missing. ETFs typically have
                 PE but no market_cap or pb_ratio; pre-fix the banner only
                 fired in the rare all-null case so users with partial-data
                 ETFs/stocks saw an apparently complete card with silent gaps. -->
            <div class="info-msg" style="margin-bottom: var(--sp-3); font-size: var(--text-xs); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--bg-soft); border: 1px solid var(--border);">
              Some fundamentals are missing for ${escapeHtml(symbol)} via our automated feed. View full details on
              <a href="https://www.tickertape.in/stocks/${escapeAttr(symbol.toLowerCase())}" target="_blank" rel="noopener noreferrer" style="color: var(--brand); font-weight: 600;">Tickertape ↗</a>.
            </div>
          ` : ""}
          <div class="fundamentals">
            ${renderFundamentals(inst, liveFundamentals, hi, lo)}
          </div>
        </div>
      </div>

      <aside>
        <div class="card trade-box">
          ${inst.kind === "MF" ? renderMfInvestBox(inst, symbol, curPrice, holding) : `
          ${!ms.open ? `
            <div class="amo-banner" style="margin-bottom: var(--sp-3); padding: var(--sp-3); border-radius: var(--r-md); background: color-mix(in srgb, var(--brand) 7%, var(--bg-soft)); border: 1px solid color-mix(in srgb, var(--brand) 35%, var(--border)); font-size: var(--text-xs); line-height: 1.45;">
              <div style="font-weight: 600; color: var(--text-strong); margin-bottom: 2px;">🕗 NSE Closed — AMO mode</div>
              <div class="dim">Your order queues now and executes at <strong style="color: var(--text-strong);">${escapeHtml(ms.nextOpenLabel || "the next market open")}</strong> at the opening price. Market orders are unavailable after hours (same behaviour as Groww).</div>
            </div>
          ` : ""}

          <div class="trade-tabs">
            <button class="trade-tab buy ${ui.side === "BUY" ? "active" : ""}" data-side="BUY">Buy</button>
            <button class="trade-tab sell ${ui.side === "SELL" ? "active" : ""}" data-side="SELL">Sell</button>
          </div>

          <div class="lb-tabs" style="margin-bottom: var(--sp-3); width: 100%;">
            <button class="lb-tab ${ui.orderType === "MARKET" ? "active" : ""}" data-otype="MARKET" style="flex: 1;${!ms.open ? " opacity: 0.45; cursor: not-allowed;" : ""}"
              ${!ms.open ? `disabled title="Market orders unavailable after hours — use Limit to queue an AMO."` : ""}>
              Market${!ms.open ? " 🔒" : ""}
            </button>
            <button class="lb-tab ${ui.orderType === "LIMIT" ? "active" : ""}" data-otype="LIMIT" style="flex: 1;">${!ms.open ? "Limit (AMO)" : "Limit"}</button>
          </div>

          ${ui.orderType === "LIMIT" ? `
            <div style="margin-bottom: var(--sp-3);">
              <label class="label" for="limit-price-input">${!ms.open ? "AMO price (₹)" : "Limit price (₹)"}</label>
              <input class="input" id="limit-price-input" type="number" min="0.01" step="0.05"
                placeholder="${(curPrice/100).toFixed(2)}"
                value="${ui.limitPrice || (curPrice/100).toFixed(2)}" inputmode="decimal" />
              <div class="dim text-xs" style="margin-top: 4px;">
                ${!ms.open
                  ? `Fills at market open when the opening tick crosses ${ui.side === "BUY" ? "at or below" : "at or above"} this price. Pre-filled with the last close — edit if you want a stricter fill.`
                  : ui.side === "BUY"
                    ? "Fires when market price drops to this level or lower."
                    : "Fires when market price rises to this level or higher."}
              </div>
            </div>
          ` : ""}

          ${holding ? `
            <div class="pill pill-brand" style="margin-bottom: var(--sp-3); font-size: var(--text-xs);">
              Holding: ${formatQty(holding.qty, inst.kind)} @ ${formatRupees(holding.avgCostPaise)} avg
            </div>
          ` : (ui.side === "SELL" ? `
            <div class="info-msg" style="margin-bottom: var(--sp-3); font-size: var(--text-xs);">You don't hold this. Buy some first.</div>
          ` : "")}

          <div id="qty-container"></div>

          <div class="order-summary">
            <div class="row"><span>Price</span><span class="num">${formatRupees(curPrice)}</span></div>
            <div class="row"><span>Qty</span><span class="num" id="os-qty">${formatQty(ui.qty, inst.kind)}</span></div>
            <div class="row total"><span>Estimated ${ui.side === "BUY" ? "cost" : "proceeds"}</span><span class="num" id="os-total">${formatRupees(Math.round(ui.qty * curPrice))}</span></div>
          </div>

          <button class="btn btn-block ${ui.side === "BUY" ? "btn-buy" : "btn-sell"}" id="place-trade-btn"
            ${ui.side === "SELL" && !holding ? "disabled" : ""}>
            ${!ms.open
              ? `Queue AMO ${ui.side === "BUY" ? "Buy" : "Sell"}`
              : ui.orderType === "LIMIT"
                ? `Place ${ui.side === "BUY" ? "Buy" : "Sell"} limit`
                : `Review ${ui.side === "BUY" ? "Buy" : "Sell"} order`}
          </button>

          ${ui.side === "SELL" && !holding ? `
            <div class="dim text-xs center" style="margin-top: var(--sp-3); color: var(--warning, var(--text-muted));">
              You don't hold any ${inst.symbol} to sell. Switch to Buy, or pick a stock from your portfolio.
            </div>
          ` : `
            <div class="dim text-xs center" style="margin-top: var(--sp-3);">
              ${!ms.open
                ? `Virtual money · Queues as AMO · Fills at ${escapeHtml(ms.nextOpenLabel || "next market open")}`
                : "Virtual money · Reviewed on a confirmation step · Coach reflection follows every trade"}
            </div>
          `}
          `}
        </div>
      </aside>
    </div>
  `;

  // Paint the cached Saathi take if we already generated one this mount
  const whyBody = main.querySelector("#stock-why-body");
  if (whyBody) {
    if (_stockWhyLast) {
      whyBody.classList.remove("muted");
      whyBody.textContent = _stockWhyLast;
    } else {
      // Fire once per (symbol, day) at module scope. Gate on liveQuote
      // (or MF — they use stable inst.nav) so we never feed the LLM a
      // synthetic getPriceAt() price or a null changePct. Pre-fix when
      // liveQuote was null at first render the explainer fired with
      // curPrice = 162910 paise (₹1629.10 from prices.js synthetic walk
      // for MTNL) and changePct = 0, producing the LLM output "MTNL at
      // ₹1629.10 is flat today (+0.00%)" while the actual values were
      // ₹30.61 / -3.65%. Worse, the bogus answer got persisted to the
      // ai_response_cache table keyed on (sym, dir, day). Gating
      // prevents the bad answer from being generated in the first
      // place.
      const haveRealPrice = inst.kind === "MF" || liveQuote != null;
      if (haveRealPrice) {
        const dk = nowIstDayKey();
        const key = `${symbol}_${dk}`;
        if (_stockWhyKey !== key) {
          _stockWhyKey = key;
          fetchStockWhy(main, symbol, inst, curPrice, liveQuote?.changePct ?? 0);
        }
      }
    }
  }

  // Attach the trade-button + every other click handler FIRST, before
  // the optional side-effects below. Previously mountQuantitySelector ran
  // before attachListeners — if it threw for any reason (stale state,
  // DOM race), the Queue AMO Buy / Place Limit / Market buttons would
  // never get a click listener and the button appeared dead (user would
  // only see the browser's default :active press animation and nothing
  // else). Reordering makes the core trade action bulletproof.
  attachListeners(main, inst, symbol, curPrice, holding, chartOhlc, sessionWindow);

  // Mount quantity selector (wrapped in try/catch so a crash here can
  // never silently kill the trade buttons).
  try {
    const qtyContainer = main.querySelector("#qty-container");
    if (qtyContainer) {
      qtySelectorHandle?.destroy?.();
      qtySelectorHandle = mountQuantitySelector(qtyContainer, {
        side: ui.side,
        kind: inst.kind,
        pricePaise: curPrice,
        cashPaise: state.portfolio?.cashPaise ?? 0,
        holdingQty: holding?.qty || 0,
        initialQty: ui.qty,
        onChange: (qty) => {
          ui.qty = qty;
          const qtyEl = main.querySelector("#os-qty");
          const totalEl = main.querySelector("#os-total");
          if (qtyEl) qtyEl.textContent = formatQty(qty, inst.kind);
          if (totalEl) totalEl.textContent = formatRupees(Math.round(qty * curPrice));
        },
      });
    }
  } catch (e) {
    console.error("[stockDetail] mountQuantitySelector failed (trade button still works):", e);
  }
}

function nowIstDayKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function fetchStockWhy(main, symbol, inst, curPricePaise, changePct) {
  // Abort-controller timeout so a slow Gemini response doesn't leave
  // the card stuck on "Reading today's news + price action…" forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    // Pull a few recent news items for this symbol to give the model
    // real grounding instead of speculation.
    const { getNews } = await import("../data/news.js");
    let newsItems = [];
    try {
      newsItems = await getNews({ limit: 10, filterSymbols: [symbol] });
    } catch {}
    if (!newsItems || newsItems.length === 0) {
      try { newsItems = await getNews({ limit: 6 }); } catch {}
    }
    const payload = {
      symbol,
      name: inst?.name || symbol,
      sector: inst?.sector || "",
      pricePaise: curPricePaise,
      changePct: (changePct || 0) * 100,
      newsItems: (newsItems || []).slice(0, 8).map(n => ({ headline: n.headline, source: n.source })),
    };
    const r = await fetch("/api/ai?op=stock-why", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`http_${r.status}`);
    const d = await r.json();
    if (!d?.explanation) throw new Error("no_explanation");
    _stockWhyLast = d.explanation;
    const el = main?.querySelector("#stock-why-body");
    if (el) {
      el.classList.remove("muted");
      el.textContent = d.explanation;
    }
  } catch (e) {
    clearTimeout(timer);
    console.warn("[stock-why] failed:", e?.name || e?.message || e);
    _stockWhyLast = null;
    const el = main?.querySelector("#stock-why-body");
    if (el) {
      el.classList.add("dim");
      el.textContent = "Couldn't read today's drivers right now. Refresh the page in a bit to retry.";
    }
  }
}

function attachListeners(main, inst, symbol, curPrice, holding, chartOhlc, sessionWindow) {
  main.querySelectorAll(".tf-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tf = btn.dataset.tf;
      // Hotfix49b: CUSTOM opens a CSS modal (was native prompt() pair).
      // Native prompts steal focus, look like a 1995 alert(), and ignore
      // the app's theming. Custom modal uses two <input type="date">
      // controls inside a styled card; ESC + click-outside cancel; the
      // chosen range stamps onto ui.customFrom / ui.customTo and triggers
      // the same reloadHistory flow.
      if (tf === "CUSTOM") {
        _openCustomRangeModal({
          initialFrom: ui.customFrom,
          initialTo: ui.customTo,
          onSubmit: ({ from, to }) => {
            ui.customFrom = from;
            ui.customTo   = to;
            ui.timeframe = "CUSTOM";
            ui.zoom = { scale: 1, centerMs: null, manualPan: false };
            ui.interval = null;
            reloadHistory(inst, symbol);
            startHistoryPoll(inst, symbol);
          },
        });
        return;   // skip the default tf-switch path below; modal's onSubmit handles it
      }
      // Every TF switch resets zoom: each timeframe has its own data
      // range and centerMs from the previous TF would land off-range
      // or outside the new sessionWindow. Starting fresh at scale=1
      // always keeps the post-switch view sensible.
      if (ui.timeframe !== tf) {
        ui.zoom = { scale: 1, centerMs: null, manualPan: false };
        ui.interval = null;
      }
      ui.timeframe = tf;
      reloadHistory(inst, symbol);
      // Restart the 1D poll lifecycle on TF changes — entering 1D
      // starts the 30-s refresh; leaving it lets the existing
      // interval's internal guard skip-without-fetching but we still
      // re-call to ensure idempotency.
      startHistoryPoll(inst, symbol);
    });
  });

  // Reset-zoom pill click handler. Only present in DOM when scale > 1.
  main.querySelector("#zoom-reset-btn")?.addEventListener("click", () => {
    resetZoom(inst, symbol);
  });
  // Refresh button — forces a fresh upstream fetch (bypasses our cache
  // AND Vercel's edge cache) so the user can pull the absolute latest
  // tick on demand. Useful when the visible "as of" timestamp lags
  // noticeably behind real-time (e.g. Yahoo's free feed is officially
  // 15-min delayed but in practice often only 1-2 min).
  main.querySelector("#price-refresh-btn")?.addEventListener("click", async () => {
    const btn = main.querySelector("#price-refresh-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
    try {
      const fresh = await getQuote(symbol, { bustCache: true });
      if (fresh) {
        liveQuote = fresh;
        render(inst, symbol);
      }
    } catch (e) {
      console.warn("[price-refresh]", e?.message || e);
    } finally {
      // The render above already re-paints the button if successful;
      // restore here only matters on the no-refresh-no-render path.
      const btn2 = main.querySelector("#price-refresh-btn");
      if (btn2) { btn2.disabled = false; btn2.textContent = "↻ Refresh"; }
    }
  });
  // Candle/Line mode toggle — no refetch, just re-render with other mode.
  main.querySelectorAll(".chart-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      ui.chartMode = btn.dataset.mode;
      render(inst, symbol);
    });
  });
  // Attach hover crosshair + tooltip (re-called on every render). Skip for
  // MFs which use the simpler lineChart (no OHLC data available). Also
  // skip while the chart-host is showing the loading skeleton — there's
  // no SVG inside it to hang hover events off, and we don't want to
  // attach hover to seeded history the user doesn't actually see.
  // Hotfix49a: previously this was gated on `inst.kind !== "MF"`. After
  // Hotfix47c-d MFs render through stockChart (with synthesized day-over-
  // day OHLC for candle mode), so they have the same SVG structure stocks
  // do â€” the hover crosshair + tooltip work identically. User-reported
  // 'mfs have no cursors or are traversable' â€” this was the gate.
  // For candle mode, pass the synthesized OHLC so the tooltip's o/h/l/c
  // values reflect what the rendered candle shows. For area mode, raw
  // OHLC works (h=l=c=NAV per day, tooltip shows the close).
  if (chartOhlc?.length) {
    const host = main.querySelector("#stock-chart-host");
    if (host && host.querySelector(".chart-svg")) {
      try {
        const hoverOhlc = (inst.kind === "MF" && ui.chartMode === "candle")
          ? _synthMfDayOverDayOhlc(chartOhlc)
          : chartOhlc;
        attachStockChartHover(host, hoverOhlc, { mode: ui.chartMode });
      } catch (e) {
        // Hotfix50a: don't let a hover-attach failure (most likely from
        // synthMfOhlc on edge-case data shapes) cascade up into the
        // router's error boundary. The chart itself is already rendered;
        // hover is a polish layer, not a hard requirement.
        console.warn("[mf chart] hover attach failed:", e);
      }

      // Attach zoom + pan gestures ONLY when xAxisRange is active (1D
      // intraday window). Other timeframes use the index-axis fallback
      // which doesn't support zoom semantics — gesture would produce
      // garbage coordinates. sessionWindow is null unless we're in the
      // 1D in-window path.
      if (_zoomDetach) { _zoomDetach(); _zoomDetach = null; }
      if (sessionWindow) {
        _zoomDetach = attachChartZoom(host, {
          getState: () => ({
            scale: ui.zoom.scale,
            centerMs: ui.zoom.centerMs,
            manualPan: ui.zoom.manualPan,
            fromMs: sessionWindow.fromMs,
            toMs: sessionWindow.toMs,
          }),
          onCommit: (next) => applyZoomCommit(inst, symbol, next),
          onReset: () => resetZoom(inst, symbol),
          onGestureActive: (active) => { _gestureActive = active; },
        });
      }
    }
  }

  main.querySelectorAll("[data-side]").forEach(btn => {
    btn.addEventListener("click", () => {
      ui.side = btn.dataset.side;
      ui.qty = inst.kind === "MF" ? 0.5 : 1;
      render(inst, symbol);
    });
  });

  main.querySelectorAll("[data-otype]").forEach(btn => {
    btn.addEventListener("click", () => {
      ui.orderType = btn.dataset.otype;
      // Same liveQuote gate as the AMO branch — never seed from
      // getPriceAt() synthetic walk. Stays empty until a real price
      // arrives.
      if (ui.orderType === "LIMIT" && !ui.limitPrice && liveQuote) {
        ui.limitPrice = (curPrice / 100).toFixed(2);
      }
      render(inst, symbol);
    });
  });

  const limitInput = main.querySelector("#limit-price-input");
  if (limitInput) {
    limitInput.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v) && v > 0) {
        ui.limitPrice = v;
        // Mark the input as user-edited so the live-quote auto-resync
        // logic in render() stops overwriting it. Without this flag,
        // every quote tick would reset the typed value back to the
        // current close.
        ui._limitDirty = true;
      }
    });
  }

  main.querySelector(".watch-btn")?.addEventListener("click", () => {
    if (getState().watchlist.includes(symbol)) {
      removeFromWatchlist(symbol);
      track("watchlist_remove", symbol);
    } else {
      addToWatchlist(symbol);
      track("watchlist_add", symbol);
    }
  });

  main.querySelector("#place-trade-btn")?.addEventListener("click", async () => {
    // Wrap in try/catch so any silent throw inside reviewTrade surfaces
    // as a visible toast instead of the button appearing "dead".
    try {
      console.log("[trade] click on place-trade-btn", { side: ui.side, qty: ui.qty, symbol });
      // Instant user feedback — if reviewTrade takes >200 ms (common on
      // Supabase RPC calls), the user gets a toast immediately confirming
      // the tap landed, not waiting on button state changes alone.
      toast({ kind: "info", message: "Processing…", duration: 1500 });
      await reviewTrade(inst, symbol, curPrice, holding);
    } catch (e) {
      console.error("[trade] reviewTrade threw:", e);
      toast({ kind: "error", message: e?.message || "Trade review failed. Check console." });
    }
  });

  // ── MF-specific handlers ──────────────────────────────────────────────
  // Live-update the units estimate + total as the user types in the
  // amount field. Approx-units math uses curPrice (paise) which for MFs
  // is set from inst.nav by the universeLoader fix.
  const mfAmt = main.querySelector("#mf-amount-input");
  if (mfAmt) {
    const updateEstimate = () => {
      const amount = parseFloat(mfAmt.value || "0");
      const navRupees = curPrice > 0 ? curPrice / 100 : 0;
      const units = navRupees > 0 ? (amount / navRupees).toFixed(4) : "—";
      const unitsEl = main.querySelector("#mf-units-estimate");
      const totalEl = main.querySelector("#mf-amount-display");
      if (unitsEl) unitsEl.textContent = units;
      if (totalEl) totalEl.textContent = `₹${(amount || 0).toLocaleString("en-IN")}`;
    };
    mfAmt.addEventListener("input", updateEstimate);
  }

  // MF Invest button — converts ₹ amount → unit count at current NAV,
  // then routes through the standard reviewTrade flow with that unit count.
  main.querySelector("#mf-invest-btn")?.addEventListener("click", async () => {
    try {
      const amountInput = main.querySelector("#mf-amount-input");
      const amount = parseFloat(amountInput?.value || "0");
      if (!amount || amount <= 0) {
        toast({ kind: "error", message: "Enter a valid amount." });
        return;
      }
      const navRupees = curPrice > 0 ? curPrice / 100 : 0;
      if (navRupees <= 0) {
        toast({ kind: "error", message: "NAV not available right now. Try again in a moment." });
        return;
      }
      // Allotment math: units = amount / NAV (rupees). 4 decimal places
      // matches AMFI's standard unit allotment precision.
      const units = +(amount / navRupees).toFixed(4);
      ui.side = "BUY";
      ui.qty = units;
      toast({ kind: "info", message: "Processing…", duration: 1500 });
      await reviewTrade(inst, symbol, curPrice, holding);
    } catch (e) {
      console.error("[mf-invest]", e);
      toast({ kind: "error", message: e?.message || "Invest failed. Check console." });
    }
  });

  // MF Redeem — same conversion, opposite side.
  main.querySelector("#mf-redeem-btn")?.addEventListener("click", async () => {
    try {
      const redeemInput = main.querySelector("#mf-redeem-input");
      const amount = parseFloat(redeemInput?.value || "0");
      if (!amount || amount <= 0) {
        toast({ kind: "error", message: "Enter a valid redeem amount." });
        return;
      }
      const navRupees = curPrice > 0 ? curPrice / 100 : 0;
      if (navRupees <= 0) {
        toast({ kind: "error", message: "NAV not available right now. Try again in a moment." });
        return;
      }
      const units = +(amount / navRupees).toFixed(4);
      if (!holding || holding.qty < units - 1e-9) {
        toast({ kind: "error", message: `You only hold ${(holding?.qty || 0).toFixed(4)} units.` });
        return;
      }
      ui.side = "SELL";
      ui.qty = units;
      toast({ kind: "info", message: "Processing…", duration: 1500 });
      await reviewTrade(inst, symbol, curPrice, holding);
    } catch (e) {
      console.error("[mf-redeem]", e);
      toast({ kind: "error", message: e?.message || "Redeem failed. Check console." });
    }
  });
}

async function reviewTrade(inst, symbol, curPrice, holding) {
  const qty = qtySelectorHandle?.get?.() ?? ui.qty;
  if (!qty || qty <= 0) { toast({ kind: "error", message: "Enter a valid quantity." }); return; }
  if (ui.side === "SELL" && (!holding || holding.qty < qty - 1e-9)) {
    toast({ kind: "error", message: `You only hold ${holding?.qty || 0}.` });
    return;
  }

  // ---- After-hours AMO path --------------------------------------------
  // Mirror Groww: when NSE is closed, we never call apply_trade — we queue
  // the order as a limit at the last-shown price, and the existing
  // limit-order matcher fills it at the first tick after market open
  // (which is mathematically the same as an AMO fill at the opening price).
  // This also sidesteps the apply_trade RPC hang that happens out-of-hours.
  const ms = marketStatus();
  if (!ms.open) {
    const fallbackRupees = curPrice / 100;
    const limitRupees = Number.isFinite(parseFloat(ui.limitPrice)) && parseFloat(ui.limitPrice) > 0
      ? parseFloat(ui.limitPrice)
      : fallbackRupees;
    const limitPaise = Math.round(limitRupees * 100);
    if (!Number.isFinite(limitPaise) || limitPaise <= 0) {
      toast({ kind: "error", message: "Couldn't read the AMO price. Edit the limit price field and try again." });
      return;
    }
    if (ui.side === "BUY" && Math.round(qty * limitPaise) > (getState().portfolio?.cashPaise || 0)) {
      toast({ kind: "error", message: "Not enough cash to reserve for this AMO." });
      return;
    }
    // Disable the button + show "Queuing…" so the user gets instant
    // feedback that their tap landed — previously a slow Supabase round
    // trip left the button looking dead for 1-3 seconds.
    const btn = document.getElementById("place-trade-btn");
    const originalLabel = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = "Queuing AMO…"; }
    try {
      console.log("[AMO] placing", { symbol, side: ui.side, qty, limitPaise });
      // Generous 25 s timeout. Supabase cold-start + edge-function
      // routing from India to an EU/US region can legitimately take
      // 8-15 s the first time in a session; 12 s was too tight and
      // made successful AMOs look like failures. At 25 s anything
      // that hasn't come back is genuinely broken.
      const res = await withRequestTimeout(
        () => placeLimitOrder({ symbol, side: ui.side, qty, limitPricePaise: limitPaise }),
        {
          timeoutMs: 25_000,
          timeoutMessage: "AMO request timed out after 25s — Supabase may be unreachable. Open DevTools console for details.",
        },
      );
      console.log("[AMO] placed", res);
      toast({
        kind: "success",
        message: `AMO queued: ${ui.side} ${formatQty(qty, inst.kind)} ${symbol} @ ₹${limitRupees.toFixed(2)}. Fills at ${ms.nextOpenLabel || "next market open"}.`,
        duration: 5000,
      });
      // Refresh local state from DB so the user sees the cash reservation
      // reflected in the UI (portfolio cashPaise drops by the reserve
      // amount). Without this, the page still shows full cash and the
      // user thinks nothing happened. Best-effort — don't block the nav.
      try {
        const { loadAllFromDb } = await import("../db/sync.js");
        await loadAllFromDb();
      } catch (syncErr) {
        console.warn("[AMO] post-queue sync failed (non-critical):", syncErr);
      }
      // Navigate to portfolio so the queued order is visible in the
      // "Pending limit orders" card — gives the user concrete evidence
      // the AMO landed, not just a toast.
      location.hash = "#/portfolio";
    } catch (e) {
      console.error("[AMO] placeLimitOrder failed:", e);
      toast({
        kind: "error",
        message: e?.message || "Could not queue AMO. Check console for details.",
        duration: 6000,
      });
      if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
    }
    return;
  }

  // ---- Limit order path — DB RPC reserves cash and records order --------
  if (ui.orderType === "LIMIT") {
    const limitRupees = parseFloat(ui.limitPrice);
    if (!Number.isFinite(limitRupees) || limitRupees <= 0) {
      toast({ kind: "error", message: "Enter a valid limit price." });
      return;
    }
    const limitPaise = Math.round(limitRupees * 100);
    console.info("[limit] click fired", { symbol, side: ui.side, qty, limitRupees, limitPaise, curPrice });
    // Basic UX sanity: BUY limit above current price or SELL limit below
    // current price would fire immediately — still valid, but warn once.
    const wouldFireNow =
      (ui.side === "BUY" && curPrice <= limitPaise) ||
      (ui.side === "SELL" && curPrice >= limitPaise);
    if (wouldFireNow) {
      // Previously used the native confirm() dialog. Two problems: (a) a
      // mobile WebView can silently auto-dismiss it with no user input,
      // and (b) even on desktop, clicking Cancel returned without any
      // toast so the user saw "Processing…" fade to nothing and thought
      // the feature was broken. Replace with a confirm() call that still
      // blocks the hot path BUT always toasts the outcome.
      const ok = confirm(`Your limit is already ${ui.side === "BUY" ? "above" : "below"} the market (${formatRupees(curPrice)}). The order will fill immediately. Continue?`);
      if (!ok) {
        toast({ kind: "info", message: "Limit order cancelled." });
        return;
      }
    }
    // Mirror AMO's 25-s Promise.race timeout pattern. The LIMIT path
    // previously did a bare `await placeLimitOrder(...)` with no
    // timeout, and placeLimitOrder calls a Supabase RPC that is KNOWN
    // to hang indefinitely when the session has silently expired (see
    // the comment block at features/limitOrders.js:62-64). With no
    // timeout, the await never resolves, no success toast fires, no
    // catch runs — button permanently stuck at "Processing…".
    // The 25-s race guarantees one of three toasts: success, explicit
    // error, or timeout-error.
    const btn = document.getElementById("place-trade-btn");
    const originalLabel = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = "Placing limit…"; }
    try {
      await withRequestTimeout(
        () => placeLimitOrder({ symbol, side: ui.side, qty, limitPricePaise: limitPaise }),
        {
          timeoutMs: 25_000,
          timeoutMessage: "Limit order timed out after 25s — Supabase may be unreachable. Check console.",
        },
      );
      toast({ kind: "success", message: `${ui.side} limit placed: ${formatQty(qty, inst.kind)} ${symbol} @ ₹${limitRupees.toFixed(2)}. Fills automatically when market crosses.` });
    } catch (e) {
      console.error("[limit] placeLimitOrder failed:", e);
      toast({ kind: "error", message: e?.message || "Could not place limit order." });
    } finally {
      // Always restore the button so the user can retry, regardless of
      // which branch fired.
      if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
    }
    return;
  }

  // ---- Market order path — existing flow --------------------------------
  if (ui.side === "BUY" && Math.round(qty * curPrice) > getState().portfolio.cashPaise) {
    toast({ kind: "error", message: "Not enough cash." });
    return;
  }

  // SELL → check panic detector FIRST (before confirmation modal)
  if (ui.side === "SELL" && holding) {
    const biasResult = detectPanicSell({
      trade: { symbol, side: "SELL", qty, pricePaise: curPrice },
      holding,
    });
    if (biasResult && biasResult.severity >= 0.35) {
      const analog = buildAnalogContext(symbol);
      showInterventionModal(
        { analog, biasResult, instrument: inst, trade: { qty, pricePaise: curPrice, holding } },
        {
          onProceed: () => showConfirm(inst, symbol, curPrice, qty, biasResult),
          onHold: () => {
            toast({ kind: "info", message: "Held. Good choice to pause." });
            recordCoachMessage({
              id: genId(), ts: Date.now(),
              eventType: "INTERVENTION_HOLD",
              triggerSymbol: symbol,
              model: "template",
              payload: {
                reflection: `You paused a panic-sell on ${inst.name}. Doing nothing in the middle of a drop is the rarest skill in investing. The muscle you just used is the one that actually matters long-term.`,
                historical_context: analog ? `Median recovery for dips of this size on ${inst.name}: ${analog.recoveryDays} trading days (n=${analog.sampleSize}).` : null,
                warning_level: "info",
                suggested_q: "Set a rule right now — if this drops another 5%, what will you do? Write it down.",
                citations: ["hold_decision", "panic_averted"],
              },
              biases: [biasResult],
            });
          },
        }
      );
      return;
    }
  }

  showConfirm(inst, symbol, curPrice, qty, null);
}

function showConfirm(inst, symbol, curPrice, qty, biasResult) {
  const modalRoot = document.getElementById("modal-root");
  const total = Math.round(qty * curPrice);
  const side = ui.side;

  modalRoot.innerHTML = `
    <div class="modal-overlay" id="confirm-overlay" role="dialog" aria-modal="true">
      <div class="modal" style="max-width: 440px;">
        <div class="modal-head">
          <div class="modal-icon ${side === "BUY" ? "success" : "warn"}">${side === "BUY" ? "✓" : "↓"}</div>
          <div>
            <div class="text-xs uppercase font-bold" style="color: ${side === "BUY" ? "var(--positive)" : "var(--negative)"};">${side} order</div>
            <h2>Confirm your ${side.toLowerCase()}</h2>
          </div>
        </div>
        <div class="modal-body">
          <div class="intervention-data">
            <div class="flex items-center justify-between">
              <div>
                <div class="dim text-xs uppercase">Instrument</div>
                <div class="font-semi" style="color: var(--text-strong);">${escapeHtml(inst.name)}</div>
                <div class="dim text-xs">${symbol}</div>
              </div>
              <div class="right">
                <div class="dim text-xs uppercase">Qty × Price</div>
                <div class="font-mono font-bold" style="color: var(--text-strong);">${formatQty(qty, inst.kind)} × ${formatRupees(curPrice)}</div>
              </div>
            </div>
            <div style="margin-top: var(--sp-3); padding-top: var(--sp-3); border-top: 1px solid var(--border);">
              <div class="flex items-center justify-between">
                <span class="dim text-xs uppercase">${side === "BUY" ? "Total cost" : "Total proceeds"}</span>
                <span class="font-mono font-bold" style="font-size: var(--text-xl); color: ${side === "BUY" ? "var(--negative)" : "var(--positive)"};">
                  ${side === "BUY" ? "−" : "+"}${formatRupees(total)}
                </span>
              </div>
            </div>
          </div>
          <div id="trade-nudge-slot" class="trade-nudge-slot loading">
            <span class="pf-digest-label">Saathi</span>
            <span class="trade-nudge-body dim">looking at your portfolio…</span>
          </div>
          <p class="text-xs dim" style="text-align: center;">Virtual money. Order executes at ${formatRupees(curPrice)}. Coach reflection follows.</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-outline" id="cancel-btn">Cancel</button>
          <button class="btn ${side === "BUY" ? "btn-buy" : "btn-sell"}" id="confirm-btn">Confirm ${side}</button>
        </div>
      </div>
    </div>
  `;

  const overlay = modalRoot.querySelector("#confirm-overlay");
  const close = () => { modalRoot.innerHTML = ""; };
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  modalRoot.querySelector("#cancel-btn").addEventListener("click", close);
  modalRoot.querySelector("#confirm-btn").addEventListener("click", () => {
    close();
    executeTrade(inst, side, qty, curPrice, biasResult);
  });
  setTimeout(() => modalRoot.querySelector("#confirm-btn")?.focus(), 50);
  // Fire the pre-trade AI nudge in parallel — doesn't block the confirm button.
  fetchTradeNudge(modalRoot, inst, symbol, side, qty, curPrice).catch(() => {});
}

async function fetchTradeNudge(modalRoot, inst, symbol, side, qty, curPricePaise) {
  const state = getState();
  const portfolioPaise = getPortfolioValue ? getPortfolioValue(state) : 0;
  const holding = state.holdings?.[symbol];
  const existingAvgRupees = holding ? holding.avgCostPaise / 100 : null;
  const existingPlPct = holding ? (curPricePaise - holding.avgCostPaise) / holding.avgCostPaise : null;
  // Sector allocation
  let sectorValue = 0;
  if (inst?.sector) {
    for (const [sym, h] of Object.entries(state.holdings || {})) {
      const si = getInstrument(sym);
      if (si?.sector === inst.sector) {
        sectorValue += h.qty * (h.avgCostPaise || 0);
      }
    }
  }
  const totalTradeCountInSymbol = (state.transactions || []).filter(t => t.symbol === symbol).length;

  try {
    const res = await fetch("/api/ai?op=trade-nudge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: side,
        symbol,
        name: inst?.name || "",
        sector: inst?.sector || "",
        qty,
        priceRupees: curPricePaise / 100,
        portfolio: {
          totalRupees: portfolioPaise / 100,
          cashRupees: state.portfolio.cashPaise / 100,
          existingQty: holding?.qty || 0,
          existingAvgRupees,
          existingPlPct,
          tradeCountInSymbol: totalTradeCountInSymbol,
          totalTradeCount: (state.transactions || []).length,
          sectorAllocPct: portfolioPaise ? (sectorValue / portfolioPaise) * 100 : 0,
        },
      }),
    });
    if (!res.ok) throw new Error("http_" + res.status);
    const d = await res.json();
    if (!d?.nudge) throw new Error("no_nudge");
    const slot = modalRoot.querySelector("#trade-nudge-slot");
    if (slot) {
      slot.classList.remove("loading");
      slot.classList.add(`sev-${d.severity || "neutral"}`);
      slot.querySelector(".trade-nudge-body")?.classList?.remove("dim");
      slot.querySelector(".trade-nudge-body").textContent = d.nudge;
    }
  } catch {
    // Modal might already be closed; silently ignore.
    const slot = modalRoot.querySelector("#trade-nudge-slot");
    if (slot) slot.remove();
  }
}

async function executeTrade(inst, side, qty, pricePaise, biasResult) {
  // Simulate real-market execution: routing → match → fill, with small
  // slippage (±0.08%) so prices feel like real fills, not simulator magic.
  try {
    // Key is generated ONCE at call time — deterministic for this click
    // intent. If the RPC times out and any internal layer retries, the
    // same key dedupes on the server. Math.random() used to be in here,
    // which defeated idempotency entirely.
    const clickTs = Date.now();
    const idempotencyKey = `${clickTs}_${inst.symbol}_${side}_${qty}`;

    toast({ kind: "info", message: `Routing ${side.toLowerCase()} order…`, duration: 900 });
    // Simulate exchange latency + matching
    await new Promise(r => setTimeout(r, 400 + Math.random() * 500));

    // Fetch fresh live quote at execution moment (may have ticked since review)
    let fillPrice = pricePaise;
    try {
      const q = await getQuote(inst.symbol);
      if (q && !q.stale) fillPrice = q.pricePaise;
    } catch {}

    // Guard: if we reached here with no valid price (Tier-2 imported stock
    // with no seed series AND no live upstream), refuse the trade rather
    // than debit NaN from cash. This is the B3 NaN-fillPrice fix.
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
      toast({ kind: "error", message: "No live price available right now — try again in a moment." });
      return;
    }

    // Realistic market slippage — BUY usually pays a hair above, SELL gets a
    // hair below the mid. Max ±0.08% for liquid names.
    const slipBps = (Math.random() * 8);
    const slipFactor = side === "BUY" ? (1 + slipBps / 10000) : (1 - slipBps / 10000);
    fillPrice = Math.round(fillPrice * slipFactor);

    const txn = await applyTrade({
      symbol: inst.symbol, side, qty, pricePaise: fillPrice, idempotencyKey,
      biasFlags: biasResult ? [biasResult] : [],
    });

    const slipText = slipBps > 0
      ? ` (slippage ${side === "BUY" ? "+" : "−"}${(slipBps).toFixed(1)}bps)`
      : "";
    toast({
      kind: "success",
      message: `Filled: ${side === "BUY" ? "Bought" : "Sold"} ${formatQty(qty, inst.kind)} ${inst.symbol} @ ${formatRupees(fillPrice)}${slipText}`,
      duration: 4500,
    });

    const state = getState();
    const isFirstTrade = state.transactions.length === 1;
    const msg = await coach({ type: side, symbol: inst.symbol, qty, pricePaise: fillPrice, txnId: txn?.id, isFirstTrade });
    recordCoachMessage(msg);
  } catch (e) {
    toast({ kind: "error", message: e.message || "Trade failed" });
    console.error(e);
  }
}

// Source-aware "as of HH:MM:SS" line shown beneath the price block.
// liveQuote.ts is in MILLISECONDS (mirrors Date.now()) — confirmed in
// marketData.js normalizeFromApi() which reads payload.ts_ms. Don't
// multiply by 1000 thinking it's seconds. The timestamp here is the
// upstream tick time (when Yahoo/Dhan recorded the price), not when
// our server fetched it — so the user sees the honest data age, not
// just the cache freshness.
function renderPriceFreshness(quote) {
  if (!quote || !quote.ts) return "";
  const asOf = new Date(quote.ts).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const src = quote.source || "—";
  // Caveat copy reflects the actual upstream. Yahoo's free NSE feed is
  // officially 15 min delayed; Dhan is real-time when configured;
  // anything else (synthetic / mf-static / unknown) just labels itself.
  let srcLabel;
  if (src === "yahoo") srcLabel = "via Yahoo (~15-min officially)";
  else if (src === "dhan") srcLabel = "via Dhan (real-time)";
  else if (src === "mf-static") srcLabel = "MF NAV (end-of-day)";
  else if (src === "synthetic") srcLabel = "via synthetic fallback";
  else srcLabel = `via ${escapeHtml(src)}`;
  const staleChip = quote.stale
    ? ` <span style="color: var(--warning, #F39C12); font-weight: 600;">· stale</span>`
    : "";
  return `
    <div class="dim text-xs" style="margin-top: 4px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
      <span>As of ${asOf} · ${srcLabel}${staleChip}</span>
      <button class="btn btn-ghost btn-sm" id="price-refresh-btn" title="Force a fresh upstream fetch (bypasses our cache)" style="padding: 2px 8px; font-size: 11px; min-height: 0;">↻ Refresh</button>
    </div>
  `;
}

function fundRow(l, v, html = false) {
  return `<div class="item"><div class="l">${l}</div><div class="v">${html ? v : escapeHtml(v)}</div></div>`;
}

function fmtMarketCap(v) {
  if (v == null) return "—";
  // v is in absolute INR
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)} L Cr`;
  if (v >= 1e7)  return `${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5)  return `${(v / 1e5).toFixed(2)} L`;
  return v.toLocaleString("en-IN");
}

function renderFundamentals(inst, live, hi52, lo52) {
  // ZERO hand-typed fallbacks — every numerical field comes from the
  // /api/fundamentals 4-tier chain (Yahoo crumb → Tickertape → cache → v8).
  // If a field is null after that chain, we render "—" rather than dragging
  // in a hand-typed inst.pe / inst.marketCap value (those fields no longer
  // exist on the instrument shape per Landing F).
  // typeof === "number" instead of != null — Yahoo's v10 quoteSummary
  // returns `dividend_yield: {}` (empty object) for many ETFs (NIFTYBEES,
  // GOLDBEES, BANKBEES). Empty object is not null/undefined so `!= null`
  // passes, then `{}.toFixed(2)` blows up to "NaN%" in the rendered UI.
  // Same defence for every numeric field — non-finite values (NaN, Infinity,
  // empty objects) all return "—" instead of crashing.
  const _num = (v) => typeof v === "number" && Number.isFinite(v);
  const mcap = _num(live?.market_cap) ? fmtMarketCap(live.market_cap) : "—";
  const pe   = _num(live?.pe_ratio)   ? live.pe_ratio.toFixed(2) : "—";
  const pb   = _num(live?.pb_ratio)   ? live.pb_ratio.toFixed(2) : "—";
  const beta = _num(live?.beta)       ? live.beta.toFixed(2) : "—";
  const dy   = _num(live?.dividend_yield)
    ? `${(live.dividend_yield * 100).toFixed(2)}%`
    : "—";
  const hi = _num(live?.fifty_two_week_high)
    ? `₹${live.fifty_two_week_high.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
    : formatRupees(hi52);
  const lo = _num(live?.fifty_two_week_low)
    ? `₹${live.fifty_two_week_low.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
    : formatRupees(lo52);
  const eps = _num(live?.eps) ? `₹${live.eps.toFixed(2)}` : null;
  const fma = _num(live?.fifty_day_average) ? `₹${live.fifty_day_average.toFixed(2)}` : null;
  const tma = _num(live?.two_hundred_day_average) ? `₹${live.two_hundred_day_average.toFixed(2)}` : null;

  // ── MF branch: a totally different shape than equity fundamentals ──
  // MFs don't have PE/PB/Beta/Dividend Yield in the equity sense — they
  // have NAV, AUM, expense ratio, fund manager, benchmark, plan/option,
  // risk-o-meter level. Build script ships category_bucket, nav,
  // nav_date, plan_type, scheme_kind, amfi_code, amc, bench, isin_growth.
  // We'll show those today; a follow-up PR can add AUM + expense ratio
  // once mfdata.in is wired up.
  if (inst.kind === "MF") {
    const navStr  = _num(inst.nav) ? `₹${inst.nav.toLocaleString("en-IN", { maximumFractionDigits: 4 })}` : "—";
    const navDate = inst.nav_date || "—";
    return [
      fundRow(termHtml("Current NAV"), navStr),
      fundRow(termHtml("NAV date"), navDate),
      fundRow(termHtml("Category"), escapeHtml(inst.category || inst.category_bucket || "—")),
      fundRow(termHtml("Plan type"), escapeHtml(inst.plan_type || "—")),
      fundRow(termHtml("Option"), escapeHtml(inst.option_type || "—")),
      fundRow(termHtml("AMC"), escapeHtml(inst.amc || "—")),
      fundRow(termHtml("Benchmark"), escapeHtml(inst.bench || "—")),
      fundRow(termHtml("AMFI code"), escapeHtml(inst.amfi_code || (inst.symbol || "").replace(/^MF_/, ""))),
      inst.isin_growth ? fundRow(termHtml("ISIN (Growth)"), escapeHtml(inst.isin_growth)) : "",
      fundRow(termHtml("Scheme type"), escapeHtml(inst.scheme_kind ? inst.scheme_kind + " Ended" : "—")),
      fundRow(termHtml("Risk-O-Meter"), `<span class="risk-pill ${inst.risk || "med"}">${(inst.risk || "med").toUpperCase()}</span>`, true),
    ].filter(Boolean).join("");
  }

  // ── ETF branch: NAV + AUM + expense ratio matter more than PE/PB.
  // ETFs trade on NSE intraday so we still show day-range / 52W / market
  // status — but PE/PB/Beta are weighted-avg of underlying constituents
  // and labeled appropriately. EPS is meaningless for an ETF basket.
  if (inst.kind === "ETF") {
    return [
      fundRow(termHtml("Type"), "Exchange Traded Fund"),
      fundRow(termHtml("Market Cap"), mcap),
      fundRow(termHtml("P/E Ratio"), pe),    // weighted-avg of underlying basket
      fundRow(termHtml("P/B Ratio"), pb),
      fundRow(termHtml("Dividend Yield", "Div Yield"), dy),
      fundRow(termHtml("Beta"), beta),
      fundRow(termHtml("52-week high", "52W High"), hi),
      fundRow(termHtml("52-week low", "52W Low"), lo),
      fma ? fundRow(termHtml("50-day moving average", "50-day avg"), fma) : "",
      tma ? fundRow(termHtml("200-day moving average", "200-day avg"), tma) : "",
      fundRow(termHtml("Risk tier"), `<span class="risk-pill ${inst.risk || "med"}">${(inst.risk || "med").toUpperCase()}</span>`, true),
    ].filter(Boolean).join("");
  }

  // Equity branch — original layout.
  // P/E label clarified to "P/E (TTM)" since pe_ratio is explicitly the
  // trailing-12-months value from Tickertape (matches Yahoo's trailingPE).
  // Annual fiscal-year PE is exposed via pe_annual for power users but
  // not displayed by default (it's typically older + materially different
  // — RELIANCE TTM 21.59 vs annual 25.80, e.g.).
  return [
    fundRow(termHtml("Market Cap"), mcap),
    fundRow(termHtml("P/E Ratio (TTM)", "P/E (TTM)"), pe),
    fundRow(termHtml("P/B Ratio"), pb),
    fundRow(termHtml("Dividend Yield", "Div Yield"), dy),
    fundRow(termHtml("Beta"), beta),
    fundRow(termHtml("52-week high", "52W High"), hi),
    fundRow(termHtml("52-week low", "52W Low"), lo),
    eps ? fundRow(termHtml("EPS", "EPS (TTM)"), eps) : "",
    fma ? fundRow(termHtml("50-day moving average", "50-day avg"), fma) : "",
    tma ? fundRow(termHtml("200-day moving average", "200-day avg"), tma) : "",
    fundRow(termHtml("Risk tier"), `<span class="risk-pill ${inst.risk || "med"}">${(inst.risk || "med").toUpperCase()}</span>`, true),
  ].filter(Boolean).join("");
}

// Build the MF-appropriate Invest/SIP/Redeem box. Replaces the entire
// equity Buy/Sell + Market/Limit + AMO trade-box for MFs.
//
// Indian MF mechanics that drive this UI:
//   - Buy in RUPEES (not units). User says "invest ₹5,000".
//   - Cutoff: 1:30 PM IST for equity/debt funds; 12:00 noon for liquid/overnight
//     (SEBI 2021 + 2025 revisions). Pre-cutoff order = today's NAV
//     (declared ~9 PM IST). Post-cutoff = tomorrow's NAV.
//   - Settlement: T+1 (liquid) to T+3 (equity). No intraday exit.
//   - SIP: monthly auto-debit ₹100/₹500 min, fixed deduction date.
//   - Redemption: ₹ amount or units. Same cutoff. Exit load 1% within
//     1 year for most equity funds.
//   - No bid/ask, no Market/Limit, no order book, no AMO.
//
// Phase 1 (this commit): Lump Sum Invest tab + Redeem tab if holding.
// Phase 2 (follow-up): SIP setup, exit-load warning with held-time math,
// step-up SIP, STP/SWP.
// Hotfix46a: detect funds that have been wound up / are zombie schemes.
// Two signals (any one is sufficient):
//   - nav < 0.01: AMFI's last-known value collapsed to ~0 (e.g. Kotak
//     Monthly Interval Plan Series 4: nav 0.0001, nav_date 2019-04-22)
//   - nav_date older than 365 days: live AMFI publishing for legitimate
//     schemes runs daily for equity/debt/hybrid and at least quarterly
//     for FOFs/closed-ended funds. A year of staleness is a strong
//     termination signal. (5,000+ MFs in mfFull.json fall under this
//     bucket â€” real graveyard.)
// Returns { terminated: bool, navDate: ISO string, ageDays: number }
function isTerminatedFund(inst) {
  if (!inst || inst.kind !== "MF") return { terminated: false };
  const nav = typeof inst.nav === "number" ? inst.nav : null;
  const navDate = inst.nav_date || null;
  if (nav != null && nav < 0.01) return { terminated: true, navDate, ageDays: null };
  if (navDate) {
    const dt = new Date(navDate);
    if (!isNaN(dt)) {
      const ageDays = Math.floor((Date.now() - dt.getTime()) / 86400000);
      if (ageDays > 365) return { terminated: true, navDate, ageDays };
    }
  }
  return { terminated: false, navDate, ageDays: null };
}

// Hotfix50a: MF chart render with try-catch fallback. Hotfix49a removed
// the `inst.kind !== 'MF'` gate on attachStockChartHover, and Hotfix47c
// routed MFs through stockChart with synthesized OHLC. Together those
// changes broke MF page reload â€” user-reported 'Something broke on this
// page' on every reload of any MF detail page. Without a clean stack
// trace from prod we can't pin the exact line, so this wrapper:
//   1. Tries the candle/area stockChart path first (same as before)
//   2. On any throw, logs the error to console and falls back to the
//      pre-Hotfix47c lineChart render. The page then loads degraded
//      (no candle mode, no zoom) but doesn't blank out.
// The console.warn surfaces the actual error so the next user report
// can include a real stack trace.
function _renderMfChartSafe(chartOhlc, uiState, width, xAxisRange) {
  try {
    if (uiState.chartMode === "candle") {
      const synth = _synthMfDayOverDayOhlc(chartOhlc);
      return `<div id="stock-chart-host" style="height: clamp(260px, 44vh, 360px); width: 100%;">${stockChart(synth, { height: 360, mode: "candle", width, xAxisRange })}</div>`;
    }
    return `<div id="stock-chart-host" style="height: clamp(260px, 44vh, 360px); width: 100%;">${stockChart(chartOhlc, { height: 360, mode: "area", width, xAxisRange })}</div>`;
  } catch (e) {
    console.warn("[mf chart] candle/area render failed â€” falling back to lineChart:", e);
    const closes = (chartOhlc || []).map(k => k?.c).filter(c => Number.isFinite(c));
    return `<div id="stock-chart-host" style="height: 300px; width: 100%;">${lineChart(closes.map(c => c / 100), { height: 300, color: "var(--brand)", rupees: true })}</div>`;
  }
}

// Hotfix49b: custom date-range picker modal. Replaces the prior native
// prompt() pair with a CSS-styled modal in #modal-root. Two date inputs
// (HTML5 type=date), defaults to the existing custom range or last
// 6 months. Submit fires onSubmit({from, to}); cancel closes silently.
// ESC key + click-outside cancel; tab/shift-tab loops within the modal.
function _openCustomRangeModal({ initialFrom, initialTo, onSubmit }) {
  const root = document.getElementById("modal-root");
  if (!root) return;
  const today = new Date();
  const sixMoAgo = new Date(today.getTime() - 180 * 86400000);
  const defFrom = initialFrom || sixMoAgo.toISOString().slice(0, 10);
  const defTo   = initialTo   || today.toISOString().slice(0, 10);
  const todayIso = today.toISOString().slice(0, 10);

  root.innerHTML = `
    <div class="modal-overlay" id="custom-range-overlay" role="dialog" aria-modal="true" aria-labelledby="custom-range-title">
      <div class="modal" style="max-width: 420px;">
        <h3 id="custom-range-title" style="margin: 0 0 var(--sp-1); font-size: var(--text-lg);">Custom date range</h3>
        <div class="dim text-xs" style="margin-bottom: var(--sp-4);">Pick a window. Yahoo data goes back ~10 years.</div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); margin-bottom: var(--sp-4);">
          <div>
            <label class="label" for="custom-from">From</label>
            <input class="input" id="custom-from" type="date" value="${escapeAttr(defFrom)}" max="${todayIso}" />
          </div>
          <div>
            <label class="label" for="custom-to">To</label>
            <input class="input" id="custom-to" type="date" value="${escapeAttr(defTo)}" max="${todayIso}" />
          </div>
        </div>
        <div id="custom-range-err" class="dim text-xs" style="color: var(--negative); min-height: 16px; margin-bottom: var(--sp-2);"></div>
        <div style="display:flex; gap: var(--sp-2); justify-content: flex-end;">
          <button class="btn btn-ghost" id="custom-range-cancel" type="button">Cancel</button>
          <button class="btn btn-primary" id="custom-range-apply" type="button">Apply</button>
        </div>
      </div>
    </div>
  `;
  const overlay = root.querySelector("#custom-range-overlay");
  const fromEl  = root.querySelector("#custom-from");
  const toEl    = root.querySelector("#custom-to");
  const errEl   = root.querySelector("#custom-range-err");
  const close = () => { root.innerHTML = ""; document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  root.querySelector("#custom-range-cancel").addEventListener("click", close);
  root.querySelector("#custom-range-apply").addEventListener("click", () => {
    const from = fromEl.value;
    const to   = toEl.value;
    if (!from || !to) { errEl.textContent = "Please pick both dates."; return; }
    if (new Date(to) <= new Date(from)) { errEl.textContent = "‘To’ must be after ‘From’."; return; }
    const dayMs = 86400000;
    const span = (new Date(to) - new Date(from)) / dayMs;
    if (span > 366 * 10) { errEl.textContent = "Range can't exceed 10 years."; return; }
    close();
    onSubmit({ from, to });
  });
  // Auto-focus the From input so keyboard users don't have to tab in.
  setTimeout(() => fromEl?.focus(), 50);
}

// Hotfix47c: AMFI publishes one NAV per scheme per day, so the raw MF
// OHLC array has o=h=l=c=NAV on every entry â€” candles render as flat
// dots, useless. Synthesize meaningful day-over-day candles where:
//   open  = previous day's close
//   close = today's NAV
//   high  = max(prev close, today's NAV)
//   low   = min(prev close, today's NAV)
//   volume = 0 (always; no volume concept for MF NAV)
// First day in the series stays as o=h=l=c since there's no prior close
// to anchor against. Result: candle body height encodes the day's NAV
// move; up days are green, down days red. Same look as a stock candle
// chart but without intraday wicks (which AMFI doesn't publish).
function _synthMfDayOverDayOhlc(rawOhlc) {
  if (!Array.isArray(rawOhlc) || rawOhlc.length < 2) return rawOhlc || [];
  const out = [{ ...rawOhlc[0] }];
  for (let i = 1; i < rawOhlc.length; i++) {
    const prev = rawOhlc[i - 1];
    const cur  = rawOhlc[i];
    const o = prev.c;
    const c = cur.c;
    out.push({
      t: cur.t,
      o,
      c,
      h: Math.max(o, c),
      l: Math.min(o, c),
      v: 0,
    });
  }
  return out;
}

function renderMfInvestBox(inst, symbol, curNavPaise, holding) {
  // Hotfix46a: short-circuit the entire invest UI for terminated funds.
  // The 'Invest' button on a wound-up scheme is a footgun â€” user can
  // click, it'd queue an order, but no AMFI feed will ever process it.
  // Show a clear status banner instead. If the user already holds the
  // fund (legacy holding from before termination), let them redeem
  // â€” redemption against frozen NAV is at least closeable, even if
  // economically degenerate.
  const term = isTerminatedFund(inst);
  if (term.terminated && !holding) {
    const navDate = term.navDate || "unknown date";
    const ageNote = term.ageDays != null ? ` (last NAV update â‰ˆ ${term.ageDays} days ago)` : "";
    return `
      <div class="trade-head" style="margin-bottom: var(--sp-3);">
        <h3 style="font-size: var(--text-base); margin-bottom: 4px;">Scheme wound up</h3>
        <div class="dim text-xs" style="line-height: 1.5;">
          This fund is no longer active${ageNote}. AMFI's last-known NAV is from
          <strong>${navDate}</strong>. New investments aren't possible — the AMC
          has stopped processing units for this scheme.
        </div>
      </div>
      <button class="btn btn-block" disabled style="opacity:0.5; cursor:not-allowed; background:var(--bg-soft); color:var(--text-dim);">Wound up</button>
      <div class="dim text-xs center" style="margin-top: var(--sp-3); line-height: 1.5;">
        Use Markets &rarr; Mutual Funds to find a similar active scheme from the same AMC.
      </div>
    `;
  }
  // Cutoff: liquid/overnight → 12:00 IST; everything else → 13:30 IST.
  const cat = (inst.category_bucket || inst.category || "").toLowerCase();
  const isLiquidLike = /liquid|overnight|money market/.test(cat);
  const cutoffLabel = isLiquidLike ? "12:00 PM IST" : "1:30 PM IST";
  // Compute current IST hour:minute to pick same-day vs next-day NAV msg.
  let beforeCutoff = false;
  try {
    const fmt = new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const parts = fmt.formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
    const totalMin = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
    const cutoffMin = isLiquidLike ? (12 * 60) : (13 * 60 + 30);
    beforeCutoff = totalMin < cutoffMin;
  } catch (_) {}
  // Hotfix51e: corrected NAV declaration timing. SEBI mandates AMCs
  // publish daily NAVs by 11 PM IST on every business day. In practice
  // most equity NAVs land 9-10 PM, debt 10-11 PM, but the regulatory
  // deadline (and the messaging that's accurate for ALL scheme types)
  // is 11 PM. Previous text said '~9 PM' which understated the window
  // and confused users seeing late updates.
  const navNote = beforeCutoff
    ? `Order before <strong>${cutoffLabel}</strong> today gets <strong>today's NAV</strong> (declared by 11 PM IST per SEBI).`
    : `After <strong>${cutoffLabel}</strong> cutoff — order will get <strong>tomorrow's NAV</strong>.`;

  // Initial amount default: ₹5000 first investment, ₹1000 if user already holds
  // (typical "additional purchase" amount).
  const defaultAmount = holding ? 1000 : 5000;
  const minInitial = 500;

  // Holding card (only when user holds the fund).
  const holdingHtml = holding ? (() => {
    const units = holding.qty;
    const avgCost = holding.avgCostPaise;
    const navPaise = curNavPaise || 0;
    const valueP = navPaise > 0 ? Math.round(units * navPaise) : null;
    const cost = Math.round(units * avgCost);
    const pl = valueP != null ? (valueP - cost) : null;
    const plPct = cost > 0 && pl != null ? pl / cost : null;
    return `
      <div style="margin-bottom: var(--sp-3); padding: var(--sp-3); background: var(--bg-soft); border-radius: var(--r-md); font-size: var(--text-xs);">
        <div class="flex justify-between"><span class="dim">Units held</span><span class="tabular">${units.toFixed(4)}</span></div>
        <div class="flex justify-between" style="margin-top: 4px;"><span class="dim">Avg cost / unit</span><span class="tabular">${formatRupees(avgCost)}</span></div>
        ${valueP != null ? `
          <div class="flex justify-between" style="margin-top: 4px;"><span class="dim">Current value</span><span class="tabular">${formatRupees(valueP)}</span></div>
          <div class="flex justify-between" style="margin-top: 4px;">
            <span class="dim">P&amp;L</span>
            <span class="tabular ${deltaClass(plPct)}">${formatRupees(pl, { sign: true })} (${formatPct(plPct, { sign: true })})</span>
          </div>
        ` : ""}
      </div>
    `;
  })() : "";

  // Approx units estimate at current NAV — informative only; actual units
  // get allotted at the day-end NAV after AMC processing.
  const navRupees = curNavPaise > 0 ? curNavPaise / 100 : 0;
  const approxUnits = navRupees > 0 ? (defaultAmount / navRupees).toFixed(4) : "—";

  return `
    <div class="trade-head" style="margin-bottom: var(--sp-3);">
      <h3 style="font-size: var(--text-base); margin-bottom: 4px;">${holding ? "Manage holding" : "Invest in this fund"}</h3>
      <div class="dim text-xs" style="line-height: 1.5;">${navNote}</div>
    </div>

    ${holdingHtml}

    <div class="lb-tabs" style="margin-bottom: var(--sp-3); width: 100%;">
      <button class="lb-tab ${ui.side === "BUY" ? "active" : ""}" data-side="BUY" style="flex:1;">${holding ? "Invest more" : "Invest"}</button>
      ${holding ? `<button class="lb-tab ${ui.side === "SELL" ? "active" : ""}" data-side="SELL" style="flex:1;">Redeem</button>` : ""}
    </div>

    ${ui.side === "BUY" ? `
      <div style="margin-bottom: var(--sp-3);">
        <label class="label" for="mf-amount-input">Amount (₹)</label>
        <input class="input" id="mf-amount-input" type="number" min="${holding ? 100 : minInitial}" step="100"
          value="${defaultAmount}" placeholder="min ₹${holding ? 100 : minInitial}" inputmode="decimal" />
        <div class="dim text-xs" style="margin-top: 4px;">
          ${holding ? "Min ₹100 additional purchase." : `Min ₹${minInitial} first investment, ₹100 additional.`}
        </div>
      </div>
      <div class="order-summary">
        <div class="row"><span>NAV</span><span class="num">${curNavPaise ? formatRupees(curNavPaise) : "—"}</span></div>
        <div class="row"><span>Approx units</span><span class="num dim" id="mf-units-estimate">${approxUnits}</span></div>
        <div class="row total"><span>Investment</span><span class="num" id="mf-amount-display">₹${defaultAmount.toLocaleString("en-IN")}</span></div>
      </div>
      <button class="btn btn-block btn-buy" id="mf-invest-btn">${holding ? "Invest More" : "Invest"}</button>
      <div class="dim text-xs center" style="margin-top: var(--sp-3); line-height: 1.5;">
        Virtual money · Units allotted at day-end NAV · No intraday price · Settlement T+1 to T+3
      </div>
    ` : `
      <div style="margin-bottom: var(--sp-3);">
        <label class="label" for="mf-redeem-input">Redeem amount (₹)</label>
        <input class="input" id="mf-redeem-input" type="number" min="100" step="100"
          value="${holding && curNavPaise ? Math.floor(holding.qty * curNavPaise / 100) : 0}" inputmode="decimal" />
        <div class="dim text-xs" style="margin-top: 4px; line-height: 1.5;">
          ${/equity|elss|small cap|mid cap|flexi cap|focused/i.test(cat) ? "1% exit load if redeemed within 1 year. " : ""}
          Money credited T+1 (liquid) to T+3 (equity) business days.
        </div>
      </div>
      <button class="btn btn-block btn-sell" id="mf-redeem-btn">Redeem</button>
      <div class="dim text-xs center" style="margin-top: var(--sp-3); line-height: 1.5;">
        Virtual money · Redemption at day-end NAV · No intraday exit
      </div>
    `}
  `;
}

function renderOrderBook(symbol, curPrice) {
  const ob = buildOrderBook(symbol, curPrice, 5);
  const trades = buildRecentTrades(symbol, curPrice, 8);
  if (!ob.bids.length) return "";
  const fmt = p => "₹" + (p / 100).toFixed(2);
  const nowAgo = ts => {
    const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
  };
  return `
    <div class="card" style="margin-top: var(--sp-4);">
      <div class="card-head">
        <h3>Order book <span class="pill pill-yellow" style="font-size:10px; margin-left:6px; vertical-align:middle;" title="Real NSE market depth requires a paid data feed (Dhan/TrueData). This book + trades are synthesised around the live LTP — useful for teaching the concept, not actual tradeable queue positions.">SIMULATED</span></h3>
        <span class="data-badge"><span class="dot"></span> Spread ${fmt(ob.spread)}</span>
      </div>
      <div class="grid" style="grid-template-columns: 1fr 1fr; gap: var(--sp-4);">
        <div>
          <div class="text-xs uppercase muted" style="margin-bottom: var(--sp-2); color: var(--positive);">Bids (buy orders)</div>
          <div class="table-wrap">
            <table class="table" style="font-size: var(--text-sm);">
              <thead><tr><th class="num">Qty</th><th class="num">Price</th></tr></thead>
              <tbody>
                ${ob.bids.map(b => `
                  <tr><td class="num">${b.qty.toLocaleString("en-IN")}</td>
                      <td class="num up">${fmt(b.price)}</td></tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div class="text-xs uppercase muted" style="margin-bottom: var(--sp-2); color: var(--negative);">Asks (sell orders)</div>
          <div class="table-wrap">
            <table class="table" style="font-size: var(--text-sm);">
              <thead><tr><th class="num">Price</th><th class="num">Qty</th></tr></thead>
              <tbody>
                ${ob.asks.map(a => `
                  <tr><td class="num down">${fmt(a.price)}</td>
                      <td class="num">${a.qty.toLocaleString("en-IN")}</td></tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div style="margin-top: var(--sp-4);">
        <div class="text-xs uppercase muted" style="margin-bottom: var(--sp-2);">Recent trades <span class="dim" style="text-transform:none; font-weight:400;">(simulated)</span></div>
        <div class="table-wrap">
          <table class="table" style="font-size: var(--text-sm);">
            <thead><tr><th>When</th><th>Side</th><th class="num">Qty</th><th class="num">Price</th></tr></thead>
            <tbody>
              ${trades.map(t => `
                <tr>
                  <td class="dim">${nowAgo(t.ts)} ago</td>
                  <td><span class="pill ${t.side === "BUY" ? "pill-green" : "pill-red"}" style="font-size: 10px;">${t.side}</span></td>
                  <td class="num">${t.qty}</td>
                  <td class="num">${fmt(t.price)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
