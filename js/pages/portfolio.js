// =============================================================================
// PORTFOLIO — Dashboard. Clean state, news column, live refresh.
// =============================================================================

// Hotfix57a: dropped getPortfolioValue / getHoldingsValue / getPortfolio-
// ReturnPct / getHoldingPLPaise / getHoldingPLPct from this import — they
// all flow through getPriceAt() which returns the seeded stub-walk for
// Tier-2 equities (inst.price=null) and bare-stub MFs (inst.nav=undefined),
// producing hero values that disagreed with the holdings-table sum. We now
// derive these locally from the same quoteCache-first holdings array the
// table displays, so the two views AGREE.
import { getState, subscribe, setReservedCashPaise } from "../state.js";
import { formatRupees, formatPct, deltaClass, formatQty } from "../money.js";
import { getInstrument } from "../data/universe.js";
// Hotfix57a: portfolio holdings of MFs were rendering bare-stub names
// ("MF_151908 ·") with synthetic walk-anchor LTPs (₹3,328.47 for a fund
// whose real NAV is ₹1,000.00). Root cause: getInstrument() returns a
// stub before mfFull.json loads, and getPriceAt/synthMFQuote both fall
// through to the seeded walk anchor (5000 + seedFromString(symbol) %
// 500000) when inst.nav is missing. Fix: kick off the universe loaders
// on portfolio mount and re-render on the loaded events. Same pattern
// stockDetail.js uses (Hotfix52a) so MF detail and portfolio agree.
import { ensureUniverseLoaded, ensureMfUniverseLoaded } from "../data/universeLoader.js";
import { getPriceAt, getTodayChange, marketStatus } from "../data/prices.js";
import { getQuoteBatch, getDataSource, subscribeToQuotes, getCachedQuotes } from "../data/marketData.js";
import { listPendingOrders, cancelOrder } from "../features/limitOrders.js";
import { getNews, fmtRelativeTime, labelSentiment } from "../data/news.js";
import { stockChart, attachStockChartHover } from "../components/charts.js";
import { fetchDigest, cachedDigest } from "../features/portfolioDigest.js";

let newsItems = [];
let quoteCache = {};
let pendingOrders = [];
let ordersUnavailable = false;
let aiDigest = null;      // { narrative, mood } | null
let aiDigestLoading = false;

// v276: the portfolio chart now renders through stockChart() — the same
// engine the stock-detail page uses — instead of the bare areaChart().
//
// areaChart positions points by ARRAY INDEX, so a trade in April and a trade
// yesterday landed the same distance apart: the x-axis was a list, not a
// timeline, and five months of holding looked identical to five minutes.
// It also had no axis dates, no hover, no reference line and no last-value
// badge. stockChart already solves every one of those for share prices, and
// a portfolio series is just an OHLC series where o === h === l === c.
//
// Selected range survives re-render (the page re-paints on every state
// change and on the 15s quote poll), so it lives at module scope.
const PF_RANGES = [
  { key: "1M",  label: "1M",  ms: 30  * 86400000 },
  { key: "3M",  label: "3M",  ms: 91  * 86400000 },
  { key: "6M",  label: "6M",  ms: 182 * 86400000 },
  { key: "1Y",  label: "1Y",  ms: 365 * 86400000 },
  { key: "ALL", label: "ALL", ms: Infinity },
];
let pfChartRange = "ALL";
let pfHoverDetach = null;

function pfChartWidth() {
  if (typeof window === "undefined") return 800;
  const iw = window.innerWidth;
  if (iw >= 900) return 800;
  if (iw >= 640) return 640;
  return Math.max(280, Math.min(440, iw - 48));
}

/**
 * DB snapshots + (optionally) the live "right now" value, as a sorted,
 * de-duplicated {t, v} series in paise.
 *
 * `liveValuePaise` is passed as null when any holding has not priced yet.
 * That matters: holdValue only sums rows with priceReady, so mid-load the
 * live total is cash-only and appending it draws a cliff straight down to
 * the cash line — a fake "you lost everything" spike on every page load.
 * When prices are not in yet we simply end the line at the last real
 * snapshot instead of inventing a point.
 */
function buildPfSeries(histRows, liveValuePaise) {
  const pts = (histRows || [])
    .map(r => ({ t: Number(r.ts), v: Number(r.valuePaise) }))
    .filter(pt => Number.isFinite(pt.t) && Number.isFinite(pt.v) && pt.v >= 0)
    .sort((a, b) => a.t - b.t);

  if (Number.isFinite(liveValuePaise) && liveValuePaise >= 0) {
    const now = Date.now();
    // Drop a snapshot written in the last 2 minutes — the daily-snapshot
    // cron or a just-executed trade would otherwise sit a pixel away from
    // the live point and render as a visual spike.
    while (pts.length && now - pts[pts.length - 1].t < 120000) pts.pop();
    pts.push({ t: now, v: liveValuePaise });
  }

  // Collapse exact-duplicate timestamps (a BUY and its snapshot can share
  // created_at to the millisecond); keep the last value written for that ms.
  const out = [];
  for (const pt of pts) {
    if (out.length && out[out.length - 1].t === pt.t) out[out.length - 1] = pt;
    else out.push(pt);
  }
  return out;
}

/** Narrow a series to the selected range, never below 2 points. */
function pfVisibleSeries(pts, rangeKey) {
  const range = PF_RANGES.find(r => r.key === rangeKey) || PF_RANGES[PF_RANGES.length - 1];
  if (!Number.isFinite(range.ms)) return { pts, fromMs: pts[0]?.t ?? 0 };
  const cutoff = Date.now() - range.ms;
  const within = pts.filter(pt => pt.t >= cutoff);
  // Fewer than two points inside the window means the window is empty of
  // history, not that the user has none — fall back to the last two rather
  // than rendering a single dot with no line.
  if (within.length < 2) return { pts: pts.slice(-2), fromMs: pts.slice(-2)[0]?.t ?? cutoff };
  return { pts: within, fromMs: Math.max(cutoff, pts[0].t) };
}

/** Which range buttons are worth showing for this much history. */
function pfUsefulRanges(pts) {
  if (pts.length < 2) return [];
  const span = pts[pts.length - 1].t - pts[0].t;
  const usable = PF_RANGES.filter(r => Number.isFinite(r.ms) && r.ms < span);
  // A lone "ALL" button is a label pretending to be a control.
  return usable.length ? [...usable, PF_RANGES[PF_RANGES.length - 1]] : [];
}

export function renderPortfolio(main) {
  let cancelled = false;
  let pollUnsub = null;

  // Instant first paint: prefill cache from localStorage-backed in-memory cache
  const state0Syms = Object.keys(getState().holdings || {});
  if (state0Syms.length) quoteCache = { ...quoteCache, ...getCachedQuotes(state0Syms) };

  // Show any same-day cached AI digest immediately so the card isn't a
  // loading skeleton on reload.
  const state0 = getState();
  aiDigest = cachedDigest(state0.user?.id || "anon");

  // Hotfix57a: kick the universe loaders BEFORE first render so the
  // holdings table doesn't paint with bare-stub names + walk-anchor
  // LTPs and then snap to real values a moment later. We still call
  // render() immediately for fast first-paint of cash / digest / news,
  // but the holdings-row helpers use the loaded?-aware logic below to
  // show "—" for MF LTPs that haven't resolved yet rather than the
  // misleading synthetic anchor (~₹3,328 for a real-NAV ₹1,000 fund).
  const holdingSyms0 = Object.keys(state0.holdings || {});
  const hasMfHolding = holdingSyms0.some(s => s.startsWith("MF_"));
  const hasEquityHolding = holdingSyms0.some(s => !s.startsWith("MF_"));
  if (hasEquityHolding) {
    ensureUniverseLoaded().then(() => { if (!cancelled) render(); }).catch(() => {});
  }
  if (hasMfHolding) {
    ensureMfUniverseLoaded().then(() => { if (!cancelled) render(); }).catch(() => {});
  }
  // Defensive belt-and-braces: also re-render on the global events the
  // loaders dispatch (someone else might trigger the load first; we still
  // want the portfolio to refresh as soon as it lands).
  const onUniLoaded = () => { if (!cancelled) render(); };
  const onMfLoaded  = () => { if (!cancelled) render(); };
  window.addEventListener("ss:universe-loaded", onUniLoaded);
  window.addEventListener("ss:mf-universe-loaded", onMfLoaded);

  render();
  const unsub = subscribe(() => { if (!cancelled) render(); });

  refreshData();

  // Poll live quotes for user's holdings every 15s
  const holdingSyms = Object.keys(state0.holdings || {});
  if (holdingSyms.length) {
    pollUnsub = subscribeToQuotes(holdingSyms, (q) => {
      if (cancelled) return;
      quoteCache = { ...quoteCache, ...q };
      render();
    }, 15_000);
  }


  // Mirror the reserved total into shared state so every OTHER consumer of
  // getPortfolioValue() -- the nav badge, the report card, and the coach's
  // get_user_portfolio tool -- agrees with what this page shows.
  function syncReserved(orders) {
    try {
      const total = (orders || []).reduce(
        (sum, o) => sum + (o.side === "BUY" ? Number(o.reserved_cash || 0) : 0), 0);
      setReservedCashPaise(total);
    } catch (e) { console.warn("[portfolio] syncReserved failed:", e); }
  }

  // Load pending limit orders (initial fetch)
  // listPendingOrders() now returns null when it could not load the list at
  // all (timeout / error), which is NOT the same as "you have no orders".
  // Rendering 0 in that case tells the user their order vanished.
  listPendingOrders().then(o => {
    if (cancelled) return;
    if (o === null) { ordersUnavailable = true; render(); return; }
    ordersUnavailable = false;
    pendingOrders = o;
    syncReserved(o);
    render();
  }).catch(() => { if (!cancelled) { ordersUnavailable = true; render(); } });

  // Live-refresh pending orders every 15 s so background-matcher fills
  // and cross-tab cancels propagate to the visible list without
  // requiring the user to navigate away and back. Symmetric with the
  // quote polling above. Shallow-compare (length + first id) so we
  // skip re-renders when nothing has moved.
  // Transient-error ride-out: if listPendingOrders returns [] (which
  // can happen on a single-tick RLS blip, a JWT that just expired
  // before the client refreshes it, or a PostgREST 5xx), we don't
  // immediately wipe the visible pendingOrders list. One empty tick
  // is counted, two empty ticks in a row confirms a real wipe. This
  // kills the "orders flicker to empty between polls" class of bugs
  // that used to happen when supabase-js silently collapsed errors
  // into data=null. Reset the streak as soon as a non-empty result
  // or a length-match confirms stable state.
  let emptyStreak = 0;
  const pendingPoll = setInterval(async () => {
    if (cancelled) return;
    try {
      const o = await listPendingOrders();
      if (cancelled) return;
      if (o === null) {
        // Could not reach the list. Keep whatever is on screen and say so,
        // rather than silently collapsing to zero.
        if (!ordersUnavailable) { ordersUnavailable = true; render(); }
        return;
      }
      if (ordersUnavailable) { ordersUnavailable = false; render(); }
      if (o.length === 0 && pendingOrders.length > 0) {
        emptyStreak++;
        if (emptyStreak < 2) return;   // wait one more tick to confirm
      } else {
        emptyStreak = 0;
      }
      const changed = o.length !== pendingOrders.length
        || (o[0]?.id !== pendingOrders[0]?.id);
      pendingOrders = o;
      syncReserved(o);
      if (changed) render();
    } catch (e) {
      console.warn("[portfolio] pending-orders poll failed:", e?.message || e);
    }
  }, 15_000);

  const onLeave = () => {
    cancelled = true;
    unsub?.();
    pollUnsub?.();
    clearInterval(pendingPoll);
    // Hotfix57a: detach the universe-loaded listeners so navigating away
    // from /portfolio doesn't leave them firing render() against a stale
    // closure (which would either throw or silently rebuild a DOM that's
    // no longer mounted).
    window.removeEventListener("ss:universe-loaded", onUniLoaded);
    window.removeEventListener("ss:mf-universe-loaded", onMfLoaded);
  };
  window.addEventListener("hashchange", onLeave, { once: true });

  async function refreshData() {
    const state = getState();
    const syms = Object.keys(state.holdings);
    if (syms.length) {
      try {
        const q = await getQuoteBatch(syms);
        if (cancelled) return;
        quoteCache = q;
        render();
      } catch (e) { console.warn("quote refresh:", e); }
    }
    try {
      const items = await getNews({ limit: 5, filterSymbols: syms.length ? syms : null });
      if (cancelled) return;
      newsItems = items;
    } catch {
      try {
        const items = await getNews({ limit: 5 });
        if (cancelled) return;
        newsItems = items;
      } catch {}
    }
    if (cancelled) return;
    render();
    // Fire the AI digest once quotes + news have landed. Cached hits return
    // instantly; uncached generation runs ~2 s on Gemini Pro and patches in.
    refreshAiDigest();
  }

  async function refreshAiDigest() {
    if (aiDigestLoading) return;
    const state = getState();
    const userId = state.user?.id || "anon";
    const holdings = Object.entries(state.holdings).map(([sym, h]) => {
      const inst = getInstrument(sym);
      const quote = quoteCache[sym];
      // Hotfix57a: same priceReady gate as the holdings table — don't
      // poison the AI digest with null/0/−100% P&L for bare-stub MFs
      // before AMFI loads. Skip pending MFs from the digest entirely;
      // the prompt asks for "your portfolio's holdings" which is fine
      // to be partial — the AI will simply describe what we know.
      let curPx = quote?.pricePaise;
      if (curPx == null) {
        if (sym.startsWith("MF_")) {
          if (inst && typeof inst.nav === "number" && inst.nav > 0) {
            curPx = Math.round(inst.nav * 100);
          }
        } else {
          const px = getPriceAt(sym, 0);
          if (typeof px === "number" && px > 0) curPx = px;
        }
      }
      if (curPx == null) return null;
      return {
        symbol: sym,
        name: inst?.name || sym,
        sector: inst?.sector || "",
        qty: h.qty,
        avgRupees: h.avgCostPaise / 100,
        curRupees: curPx / 100,
        dayPct: ((quote?.changePct) ?? (sym.startsWith("MF_") ? 0 : getTodayChange(sym))) * 100,
        plPct: h.avgCostPaise > 0 ? (curPx - h.avgCostPaise) / h.avgCostPaise : 0,
      };
    }).filter(Boolean);
    // Hotfix57a: derive total + deltaPct from the same quoteCache-aware
    // holdings array we just built. Same reason the hero uses local
    // computation — getPortfolioValue/getPortfolioReturnPct route through
    // getPriceAt() which serves the seeded stub-walk for Tier-2 stocks
    // (inst.price=null), making the AI digest narrate fake numbers.
    let holdingsRupees = 0;
    for (const h of holdings) holdingsRupees += h.qty * h.curRupees;
    const totalRupees = state.portfolio.cashPaise / 100 + holdingsRupees;
    const startRupees = state.portfolio.startingCashPaise / 100;
    const deltaPct = startRupees > 0
      ? ((totalRupees - startRupees) / startRupees) * 100
      : 0;
    const payload = {
      totalRupees,
      deltaPct,
      cashRupees: state.portfolio.cashPaise / 100,
      holdings,
    };
    aiDigestLoading = true;
    render();
    try {
      const d = await fetchDigest(userId, payload);
      if (cancelled) return;
      aiDigest = d;
    } catch (e) {
      console.warn("portfolio digest:", e);
      // Leave any previously-cached digest on screen; fail silently.
    } finally {
      aiDigestLoading = false;
      if (!cancelled) render();
    }
  }

  function render() {
    const state = getState();
    const cash = state.portfolio.cashPaise;

    const holdings = Object.entries(state.holdings)
      .map(([sym, h]) => {
        const inst = getInstrument(sym);
        if (!inst) return null;
        const quote = quoteCache[sym];

        // Hotfix57a: separate "have a real price" from "fall through to
        // the seeded walk anchor". For MFs, the synthetic walk produces
        // values like ₹3,328.47 for a fund whose real NAV is ₹1,000.00
        // (seedFromString("MF_151908") % 500000 happens to land there),
        // which then drives a fake +232% P&L and a misleading "value"
        // tile. We refuse to render those numbers — show "—" until either
        // a real quote arrives or AMFI universe loads inst.nav.
        const isMf = inst.kind === "MF" || sym.startsWith("MF_");
        const isBareStub = inst._stub === true;

        let curPx = quote?.pricePaise ?? null;
        let priceReady = curPx != null;
        if (!priceReady) {
          if (isMf) {
            // Only trust inst.nav when AMFI universe has loaded
            // (the bare-stub path leaves nav undefined). Synthetic walk
            // for MFs is never acceptable here.
            if (!isBareStub && typeof inst.nav === "number" && inst.nav > 0) {
              curPx = Math.round(inst.nav * 100);
              priceReady = true;
            }
          } else {
            // Equity / ETF: getPriceAt is fine — the seeded walk for
            // these IS a believable price line until /api/live-quote
            // lands, and Tier-2 stubs still produce a coherent walk.
            const px = getPriceAt(sym, 0);
            if (typeof px === "number" && px > 0) {
              curPx = px;
              priceReady = true;
            }
          }
        }

        const value = priceReady ? Math.round(h.qty * curPx) : null;
        const pl = priceReady ? Math.round((curPx - h.avgCostPaise) * h.qty) : null;
        const plPct = priceReady && h.avgCostPaise > 0
          ? (curPx - h.avgCostPaise) / h.avgCostPaise
          : null;
        const dayChange = quote?.changePct ?? (priceReady ? getTodayChange(sym) : null);

        return {
          sym, inst, h, curPx, value, pl, plPct, dayChange,
          source: quote?.source,
          priceReady, isMf, isBareStub,
        };
      })
      .filter(Boolean)
      // priceReady rows sorted by value desc; pending rows pinned at the
      // bottom with a stable order so they don't flicker positions while
      // the universe is loading.
      .sort((a, b) => {
        if (a.priceReady !== b.priceReady) return a.priceReady ? -1 : 1;
        if (a.priceReady) return b.value - a.value;
        return a.sym.localeCompare(b.sym);
      });

    // Hotfix57a: derive hero/invested-tile values from the `holdings`
    // array we just built — they use the same quoteCache-first logic as
    // the holdings table, so the two displays AGREE. Previously we called
    // getHoldingsValue(state) which goes back through getPriceAt() and
    // ends up reading the seeded stub-walk for any Tier-2 equity whose
    // inst.price is null (i.e. nearly all of them — Tier-2 rows leave
    // price=null and live values come from /api/live-quote into
    // _quoteCache). Result: hero invested said ₹6,857 while the holdings
    // table summed to ₹7,733 — a ~₹876 discrepancy on a 2-position
    // portfolio. Fixed by deriving locally.
    let holdValue = 0;
    for (const h of holdings) {
      if (h.priceReady && Number.isFinite(h.value)) holdValue += h.value;
    }
    // Cash reserved against pending BUY orders belongs in the total.
    // place_limit_order deducts it from cash_paise the moment an order is
    // queued, and the shares do not exist yet, so without this term the
    // money is in NEITHER bucket. Queueing a Rs 6,287 AMO on a Rs 1,00,019
    // portfolio rendered "Rs 93,732 -6.27% since start" -- telling a
    // teenager they lost 6% for placing an order they had not even filled.
    const reserved = pendingOrders.reduce(
      (sum, o) => sum + (o.side === "BUY" ? Number(o.reserved_cash || 0) : 0), 0);
    const pfValue = cash + holdValue + reserved;
    const start = state.portfolio.startingCashPaise;
    const deltaPaise = pfValue - start;
    const returnPct = start ? deltaPaise / start : 0;

    const src = getDataSource();
    // Hotfix66a: state.portfolioHistory is populated by sync.js with
    // {ts, valuePaise} rows from Supabase. (v275 fixed the reason those
    // rows never arrived: js/state.js rebuilds its store from an explicit
    // key allowlist, portfolioHistory was in neither the getState()
    // projection nor applyFullPatch's, so every fetched row was written
    // into a throwaway object and dropped one line later. This value read
    // `undefined` for every user, which is why the placeholder below was
    // pinned on screen for all of them regardless of their data.)
    const histPaiseRows = Array.isArray(state.portfolioHistory) ? state.portfolioHistory : [];
    // Only anchor the right edge to the live value once EVERY holding has a
    // real price — see buildPfSeries for why a half-priced total is worse
    // than no point at all.
    const allPriced = holdings.every(h => h.priceReady);
    const pfSeries = buildPfSeries(histPaiseRows, allPriced ? pfValue : null);
    const hasRealHistory = pfSeries.length > 1;
    const pfRanges = pfUsefulRanges(pfSeries);
    if (pfRanges.length && !pfRanges.some(r => r.key === pfChartRange)) pfChartRange = "ALL";
    const pfVisible = hasRealHistory ? pfVisibleSeries(pfSeries, pfChartRange) : { pts: [], fromMs: 0 };
    const pfOhlc = pfVisible.pts.map(pt => ({ t: pt.t, o: pt.v, h: pt.v, l: pt.v, c: pt.v }));

    main.innerHTML = `
      <div class="portfolio-hero">
        <div>
          <div class="dim text-xs uppercase" style="margin-bottom: 6px;">
            ${escapeHtml(state.user.displayName || state.user.username || "Your")} portfolio
          </div>
          <div class="pf-value tabular">${formatRupees(pfValue)}</div>
          <div class="pf-delta tabular ${deltaClass(deltaPaise)}">
            ${formatRupees(deltaPaise, { sign: true })} (${formatPct(returnPct, { sign: true })}) since start
          </div>
        </div>
        <div class="flex gap-2 wrap">
          <a href="#/stocks" class="btn btn-primary">+ Invest</a>
          <a href="#/friends" class="btn btn-ghost">Send money</a>
          <a href="#/report-card" class="btn btn-ghost">Report card</a>
        </div>
      </div>

      ${renderDigestCard()}

      ${pendingOrders.length ? renderAmoBanner(pendingOrders) : ""}

      <div class="portfolio-stats">
        <div class="stat-tile"><div class="l">Cash</div><div class="v tabular">${formatRupees(cash, { compact: true })}</div></div>
        <div class="stat-tile"><div class="l">Invested</div><div class="v tabular">${formatRupees(holdValue, { compact: true })}</div></div>
        <div class="stat-tile"><div class="l">Holdings</div><div class="v tabular">${holdings.length}</div></div>
        <div class="stat-tile ${pendingOrders.length ? 'has-pending' : ''}"><div class="l">Queued AMOs</div><div class="v tabular" ${ordersUnavailable ? 'title="Could not load your queued orders just now — this is a display problem, not a cancellation. Your orders are safe."' : ''}>${ordersUnavailable ? "—" : pendingOrders.length}</div></div>
      </div>

      <div class="portfolio-grid">
        <div class="flex-col gap-4">
          <div class="card">
            <div class="card-head">
              <h3>Value over time</h3>
              <span class="data-badge"><span class="dot"></span> ${escapeHtml(src.name)}</span>
            </div>
            ${hasRealHistory && pfRanges.length ? `
              <div style="display:flex; gap:4px; flex-wrap:wrap; margin-bottom: var(--sp-2);">
                ${pfRanges.map(r => `<button class="tf-btn ${pfChartRange === r.key ? "active" : ""}" data-pf-range="${r.key}">${r.label}</button>`).join("")}
              </div>` : ""}
            <div id="pf-chart-host" style="height: clamp(240px, 38vh, 300px); position: relative;">
              ${hasRealHistory
                ? stockChart(pfOhlc, {
                    height: 300,
                    width: pfChartWidth(),
                    mode: "area",
                    xAxisRange: { fromMs: pfVisible.fromMs, toMs: Date.now() },
                    lastLabelFormat: (paise) => formatRupees(paise, { compact: true }),
                    // Portfolio spreads are small relative to a lakh-scale
                    // total, so the y-axis needs span-derived precision or
                    // every tick reads the same number. See makeAxisFormatter.
                    axisFormat: "span",
                  })
                : `<div style="height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; border: 1px dashed var(--border); border-radius: var(--r); background: var(--surface);">
                    <div style="font-size: 40px; opacity: 0.45;">📈</div>
                    <div class="font-semi" style="color: var(--text-strong);">Make your first trade to start charting</div>
                    <div class="muted text-sm" style="text-align: center; max-width: 340px;">Buy any stock or fund and your portfolio value gets snapshotted automatically. The line builds up from there.</div>
                  </div>`}
            </div>
            ${hasRealHistory && !allPriced ? `
              <div class="dim text-xs" style="margin-top:6px;">Live value lands once every holding has priced — the line ends at your last snapshot until then.</div>` : ""}
          </div>

          <div class="card">
            <div class="card-head">
              <h3>Holdings</h3>
              ${holdings.length ? `<span class="dim text-xs">${holdings.length} position${holdings.length !== 1 ? "s" : ""}</span>` : ""}
            </div>
            ${holdings.length ? renderHoldingsTable(holdings) : renderEmptyHoldings()}
          </div>

          ${ordersUnavailable && !pendingOrders.length ? `
            <div class="card" id="order-list" style="border: 1px solid var(--warning, #b26a00);">
              <div class="card-head"><h3><span>🕗</span> Queued AMOs &amp; Limit orders</h3></div>
              <p class="dim text-sm" style="margin: 0;">
                Couldn't load your queued orders just now — that's a display
                problem on our side, not a cancellation. Nothing has been
                cancelled and any queued order will still execute on our
                servers. Try again in a moment.
              </p>
            </div>
          ` : ""}

          ${pendingOrders.length ? `
            <div class="card" id="order-list" style="border: 1px solid color-mix(in srgb, var(--brand) 40%, var(--border));">
              <div class="card-head">
                <h3>
                  <span style="color: var(--brand);">🕗</span>
                  Queued AMOs &amp; Limit orders
                  <span class="pill pill-brand" style="margin-left: 6px; font-size: 11px;">${pendingOrders.length}</span>
                </h3>
              </div>
              <div class="flex-col gap-2">
                ${pendingOrders.map(o => {
                  const inst = getInstrument(o.symbol) || { name: o.symbol };
                  const limitRupees = Number(o.limit_price_paise) / 100;
                  const reserveRupees = o.side === "BUY" ? (Number(o.reserved_cash || 0) / 100) : null;
                  return `
                    <div class="flex items-center justify-between" style="padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r); background: var(--surface);">
                      <div>
                        <div class="text-md"><span class="pill ${o.side === "BUY" ? "pill-green" : "pill-red"}">${o.side} LIMIT</span> <strong>${escapeHtml(inst.name)}</strong></div>
                        <div class="dim text-xs">${o.qty} × ₹${limitRupees.toFixed(2)} · queued ${timeSince(new Date(o.created_at))} ago${reserveRupees != null ? ` · ₹${reserveRupees.toFixed(2)} reserved` : ""}</div>
                      </div>
                      <button class="btn btn-ghost btn-sm" data-cancel-order="${o.id}">Cancel</button>
                    </div>
                  `;
                }).join("")}
              </div>
            </div>
          ` : ""}

          <div class="card">
            <div class="card-head"><h3>Recent activity</h3></div>
            ${renderActivity(state)}
          </div>
        </div>

        <div class="flex-col gap-4">
          <div class="card">
            <div class="card-head">
              <h3>In the news</h3>
              <a href="#/news" class="btn-link">See all →</a>
            </div>
            ${newsItems.length
              ? `<div class="flex-col gap-2">${newsItems.slice(0, 5).map(n => `
                  <a href="#/news" class="news-item" style="padding: 12px;" data-nid="${escapeAttr(n.id)}">
                    <div class="meta">
                      <span class="news-source">${escapeHtml(n.source)} · ${fmtRelativeTime(n.ts)}</span>
                      <span class="sentiment ${n.sentiment}">${labelSentiment(n.sentiment)}</span>
                    </div>
                    <div class="headline" style="font-size: var(--text-sm);">${escapeHtml(n.headline)}</div>
                  </a>`).join("")}</div>`
              : `<p class="muted text-sm">Loading market news…</p>`
            }
          </div>

          <div class="card">
            <div class="card-head"><h3>Quick actions</h3></div>
            <div class="flex-col gap-2">
              <a href="#/stocks" class="btn btn-ghost">📈 Browse markets</a>
              <a href="#/news" class="btn btn-ghost">📰 Market news</a>
              <a href="#/crash-replay" class="btn btn-ghost">⏱ Time travel</a>
              <a href="#/friends" class="btn btn-ghost">💸 Send money</a>
            </div>
          </div>
        </div>
      </div>
    `;

    // Chart: crosshair + tooltip, and the range selector. Both have to be
    // re-wired on every render because render() replaces main.innerHTML
    // wholesale (state change, 15s quote poll, universe load...).
    if (pfHoverDetach) { try { pfHoverDetach(); } catch {} pfHoverDetach = null; }
    const chartHost = main.querySelector("#pf-chart-host");
    if (chartHost && pfOhlc.length > 1) {
      pfHoverDetach = attachStockChartHover(chartHost, pfOhlc, {
        mode: "area",
        // The stock tooltip reports O/H/L/C and quantises to NSE's 5-paise
        // equity tick. Both are wrong here: a portfolio point has no
        // intraday range (o === h === l === c), and rounding somebody's net
        // worth to a share-price tick is meaningless. Show what the user
        // actually wants off this chart — what it was worth, when, and how
        // far that is from where the visible window started.
        tooltipRows: ({ interpClose, noDataHere, headerRow, first }) => {
          if (noDataHere || interpClose == null) {
            return [headerRow, `<span style="color:var(--text-dim); font-style:italic;">(no snapshot yet)</span>`];
          }
          const deltaPaise = interpClose - first.c;
          const pct = first.c ? deltaPaise / first.c : 0;
          const cls = deltaPaise >= 0 ? "var(--positive)" : "var(--negative)";
          return [
            headerRow,
            `<strong style="font-size:13px;">${formatRupees(Math.round(interpClose))}</strong>`,
            `<span style="color:${cls}">${formatRupees(Math.round(deltaPaise), { sign: true })} (${formatPct(pct, { sign: true })})</span>`,
            `<span style="color:var(--text-dim)">since ${new Date(first.t).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</span>`,
          ];
        },
      });
    }
    main.querySelectorAll("[data-pf-range]").forEach(btn => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.pfRange;
        if (!key || key === pfChartRange) return;
        pfChartRange = key;
        render();
      });
    });

    // Wire up Cancel buttons on Pending orders. Without this the buttons
    // looked active but did nothing — users assumed the AMO system was
    // broken when they couldn't cancel a queued order.
    main.querySelectorAll("[data-cancel-order]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.cancelOrder;
        if (!id) return;
        btn.disabled = true;
        btn.textContent = "Cancelling…";
        try {
          await cancelOrder(id);
          // Refresh the pending-orders list + portfolio cash (the cancelled
          // order's reserved cash should now be back in the wallet).
          try {
            pendingOrders = await listPendingOrders();
            const { loadAllFromDb } = await import("../db/sync.js");
            await loadAllFromDb();
          } catch {}
          render();
        } catch (e) {
          console.error("[portfolio] cancel order failed:", e);
          btn.disabled = false;
          btn.textContent = "Cancel";
        }
      });
    });

    // Smooth-scroll anchors marked data-scroll-to="<selector>". Replaces
    // the previous inline onclick="..." on the AMO banner's "Jump to
    // orders" link — that inline handler violated the site's CSP
    // (script-src 'self' https://esm.sh has no 'unsafe-inline'), spamming
    // the console with one violation per banner render. Delegated JS
    // listener keeps the smooth-scroll behaviour without tripping CSP.
    main.querySelectorAll("[data-scroll-to]").forEach(el => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        const target = el.getAttribute("data-scroll-to");
        if (!target) return;
        document.querySelector(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function renderDigestCard() {
    if (!aiDigest && !aiDigestLoading) return "";
    if (aiDigestLoading && !aiDigest) {
      return `
        <div class="pf-digest-card loading">
          <div class="pf-digest-head"><span class="pf-digest-label">Saathi</span><span class="dim text-xs">reading your portfolio…</span></div>
          <div class="pf-digest-body skeleton" style="height: 48px; border-radius: 6px;"></div>
        </div>
      `;
    }
    const moodClass = `mood-${aiDigest.mood || "flat"}`;
    return `
      <div class="pf-digest-card ${moodClass}">
        <div class="pf-digest-head">
          <span class="pf-digest-label">Saathi</span>
          ${aiDigestLoading ? `<span class="dim text-xs">refreshing…</span>` : ""}
        </div>
        <div class="pf-digest-body">${escapeHtml(aiDigest.narrative)}</div>
      </div>
    `;
  }
}

function renderHoldingsTable(holdings) {
  return `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th></th>
            <th>Instrument</th>
            <th class="num">Qty</th>
            <th class="num">Avg cost</th>
            <th class="num">LTP</th>
            <th class="num">Today</th>
            <th class="num">Value</th>
            <th class="num">P&amp;L</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${holdings.map(h => {
            // Hotfix57a: stub-aware row rendering. Bare-stub rows are
            // common during cold-load before the AMFI catalog finishes
            // streaming in (especially MF holdings — equities have
            // featured-symbol stubs that look reasonable). Don't show
            // "MF_151908 · " with a synthetic walk-anchor LTP; show the
            // ticker + a "Loading…" hint and "—" in the price cells.
            const displayName = h.isBareStub
              ? (h.isMf ? "Loading fund details…" : escapeHtml(h.inst.name || h.sym))
              : escapeHtml(h.inst.name || h.sym);
            const sectorPart = h.inst.sector && h.inst.sector !== "Unknown"
              ? " · " + escapeHtml(h.inst.sector)
              : "";
            const ltpCell = h.priceReady
              ? formatRupees(h.curPx)
              : `<span class="dim">—</span>`;
            const todayCell = h.priceReady
              ? `<span class="${deltaClass(h.dayChange)}">${formatPct(h.dayChange, { sign: true })}</span>`
              : `<span class="dim">—</span>`;
            const valueCell = h.priceReady
              ? formatRupees(h.value, { compact: true })
              : `<span class="dim">—</span>`;
            const plCell = h.priceReady
              ? `<div class="${deltaClass(h.pl)}">${formatRupees(h.pl, { sign: true, compact: true })}</div>
                 <div class="${deltaClass(h.pl)}" style="font-size: 11px;">${formatPct(h.plPct, { sign: true })}</div>`
              : `<span class="dim">—</span>`;
            return `
            <tr class="clickable" data-sym="${h.sym}">
              <td><div class="stock-avatar" style="width: 32px; height: 32px; font-size: 10px;">${escapeHtml(h.inst.logo || h.sym.slice(0, 3))}</div></td>
              <td>
                <div class="font-semi" style="color: var(--text-strong);">${displayName}</div>
                <div class="dim text-xs">${escapeHtml(h.sym)}${sectorPart}</div>
              </td>
              <td class="num">${formatQty(h.h.qty, h.inst.kind)}</td>
              <td class="num">${formatRupees(h.h.avgCostPaise)}</td>
              <td class="num">${ltpCell}</td>
              <td class="num">${todayCell}</td>
              <td class="num">${valueCell}</td>
              <td class="num">${plCell}</td>
              <td><a class="btn btn-ghost btn-sm" href="#/stocks/${h.sym}">Trade</a></td>
            </tr>
          `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderEmptyHoldings() {
  return `
    <div class="empty-state">
      <span class="emoji">📊</span>
      <h3>No holdings yet</h3>
      <p>Pick a stock or mutual fund to get started. Every trade triggers a behavioral reflection from the coach.</p>
      <a href="#/stocks" class="btn btn-primary">Browse markets</a>
    </div>
  `;
}

function renderActivity(state) {
  const txns = state.transactions.slice().reverse().slice(0, 5);
  const transfers = state.transfers.slice().reverse().slice(0, 3);
  if (!txns.length && !transfers.length) {
    return `<p class="muted text-sm" style="text-align: center; padding: var(--sp-4);">No activity yet. Your trades and transfers will show here.</p>`;
  }
  const rows = [];
  for (const t of txns) {
    const inst = getInstrument(t.symbol);
    rows.push({
      type: "trade",
      ts: t.ts,
      left: `<span class="pill ${t.side === "BUY" ? "pill-green" : "pill-red"}">${t.side}</span> ${inst ? escapeHtml(inst.name) : t.symbol}`,
      right: `${formatQty(t.qty, inst?.kind)} @ ${formatRupees(t.pricePaise)}`,
      amount: (t.side === "BUY" ? "−" : "+") + formatRupees(t.valuePaise, { compact: true }),
      ac: t.side === "BUY" ? "down" : "up",
    });
  }
  for (const t of transfers) {
    rows.push({
      type: "transfer",
      ts: t.ts,
      left: `<span class="pill ${t.direction === "in" ? "pill-green" : "pill-red"}">${t.direction === "in" ? "RECEIVED" : "SENT"}</span> ${escapeHtml(t.counterpartyName || "Transfer")}`,
      right: escapeHtml(t.note || ""),
      amount: (t.direction === "in" ? "+" : "−") + formatRupees(t.amountPaise, { compact: true }),
      ac: t.direction === "in" ? "up" : "down",
    });
  }
  rows.sort((a, b) => b.ts - a.ts);

  return `
    <div class="flex-col gap-2">
      ${rows.slice(0, 6).map(r => {
        const d = new Date(r.ts);
        const when = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) + " · " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
        return `
          <div class="flex items-center justify-between" style="padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r); background: var(--surface);">
            <div>
              <div class="text-md">${r.left}</div>
              <div class="dim text-xs">${when} · ${r.right}</div>
            </div>
            <div class="num font-bold ${r.ac}">${r.amount}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

// Human-readable "X ago" for Pending-orders queued timestamps.
function timeSince(d) {
  const ms = Date.now() - d.getTime();
  const s = Math.max(1, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Hero-style banner shown above the stat tiles whenever the user has at
// least one pending AMO / limit order. Makes it unmissable that money
// is reserved for an order queued at the next market open — previously
// the pending-orders card was tucked below Holdings and users wondered
// where their cash went after queuing an AMO.
function renderAmoBanner(pendingOrders) {
  const ms = marketStatus();
  const countLabel = `${pendingOrders.length} order${pendingOrders.length > 1 ? "s" : ""}`;
  const buyCount = pendingOrders.filter(o => o.side === "BUY").length;
  const sellCount = pendingOrders.length - buyCount;
  const breakdown = [
    buyCount ? `${buyCount} buy` : null,
    sellCount ? `${sellCount} sell` : null,
  ].filter(Boolean).join(" · ");
  const timingLine = ms.open
    ? "Fills when the market price crosses your limit."
    : `Fills at ${escapeHtml(ms.nextOpenLabel || "the next market open")} at the opening tick.`;
  return `
    <div class="card" style="margin-bottom: var(--sp-4); padding: var(--sp-4); background: color-mix(in srgb, var(--brand) 8%, var(--bg-soft)); border: 1px solid color-mix(in srgb, var(--brand) 38%, var(--border));">
      <div class="flex items-center gap-3 wrap">
        <span style="font-size: 22px;" aria-hidden="true">🕗</span>
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 600; color: var(--text-strong);">${countLabel} queued${breakdown ? ` · ${escapeHtml(breakdown)}` : ""}</div>
          <div class="muted text-xs" style="margin-top: 2px; line-height: 1.5;">${timingLine} Scroll down to review or cancel.</div>
        </div>
        <a href="#order-list" class="btn btn-ghost btn-sm" data-scroll-to="#order-list">Jump to orders</a>
      </div>
    </div>
  `;
}
