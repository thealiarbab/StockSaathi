// =============================================================================
// BIAS CORE — the behaviour detectors, as pure functions (rewritten 24 Oct).
//
// No imports and no app state: everything a detector needs comes in `ctx`, so
// the same code runs in the browser (biasDetectors.js feeds it), in Node
// (scripts/test-bias-core.mjs) and against the real trade history.
//
// What the old detectors got wrong, measured on the 7,139 real trades:
//   - "today" was the LAST BAR in the cache, not the trade: a sell on Monday
//     morning was judged on Friday's close-to-close move, and the user's own
//     sell price was never looked at;
//   - fixed thresholds (5% in 3 days) ignored how jumpy a stock is: an SME
//     that moves 4% a day tripped "panic" on noise, a large cap falling 4%
//     (a rare move for it) did not;
//   - P&L was today's close against cost, not the price actually sold at;
//   - a 10% trim counted the same as dumping the whole position;
//   - "anchoring" fired on any buy within 2% of the 52-week high or low,
//     which is not a bias, just a price level;
//   - sector and concentration fired on SELLS that reduced the very
//     concentration they warned about;
//   - churning counted every BUY/SELL alternation, so one partial exit and
//     re-entry was "churning".
//
// Every detector returns null or { bias, severity 0..1, evidence }. Evidence
// numbers are what the note shows the user, so they are real and rounded.
//
// ctx = {
//   trade:   { symbol, side, qty, pricePaise, at }       at = ms, decision time
//   kind:    "STOCK" | "ETF" | "MF" ...                   of trade.symbol
//   sector:  string | null                                of trade.symbol
//   bars:    [{ t, o, h, l, c }] daily, oldest first, paise, REAL data only
//   indexBars: Nifty 50 daily bars or null (context, never a gate)
//   holdingBefore: { qty, avgCostPaise } | null
//   history: earlier trades [{ symbol, side, qty, pricePaise, ts, auto }]
//            (auto = filled by the order matcher, not a tap)
//   portfolio: AFTER the trade { cashPaise, positions: { SYM: { qty,
//            avgCostPaise, pricePaise|null, sector, kind } } }
// }
// =============================================================================

const DAY = 86_400_000;
const SESSION_MS = 6.25 * 3_600_000;        // 09:15 -> 15:30 IST
const IST = 5.5 * 3_600_000;

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const r1 = (x) => Math.round(x * 1000) / 10;   // fraction -> % with 1 decimal
const istDay = (ms) => Math.floor((ms + IST) / DAY);

/** Closes of sessions that had ENDED by `at` (Yahoo stamps a day at its open). */
export function completedCloses(bars, at) {
  if (!Array.isArray(bars)) return [];
  const out = [];
  for (const b of bars) {
    if (!(b?.c > 0)) continue;
    if (b.t + SESSION_MS <= at) out.push(b.c);
  }
  return out;
}

/** Typical daily move (stdev of daily log returns, last 60 sessions). */
export function dailyVol(closes) {
  const c = closes.slice(-61);
  if (c.length < 21) return null;
  const r = [];
  for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1);
  return Math.max(0.007, Math.sqrt(v));
}

const isFund = (kind) => kind === "MF";

// A trade price far from the last close means the bars and the trade disagree
// (a split or bonus adjusted the history, or a bad quote): no exchange band
// lets a stock move 25% between sessions, so nothing price-based is judged.
function priceSane(P, closes) {
  const last = closes[closes.length - 1];
  return P > 0 && last > 0 && Math.abs(P / last - 1) <= 0.25;
}
const isBasket = (kind) => kind === "MF" || kind === "ETF";

// Average cost book over earlier trades: open round trip per symbol and the
// P&L of every sell. Same rounding as data/tradeStats.js.
function ledger(history) {
  const book = {};
  const sells = [];
  const trips = [];
  for (const t of [...(history || [])].sort((a, b) => a.ts - b.ts)) {
    const q = Number(t.qty) || 0, px = Number(t.pricePaise) || 0;
    if (!t.symbol || q <= 0) continue;
    const b = book[t.symbol] || (book[t.symbol] = { qty: 0, avg: 0, openTs: null, buys: [] });
    if (t.side === "BUY") {
      if (b.qty <= 1e-9) { b.openTs = t.ts; b.buys = []; }
      b.buys.push({ ts: t.ts, px, avgBefore: b.qty > 0 ? b.avg : null });
      const nq = b.qty + q;
      b.avg = Math.round((b.avg * b.qty + px * q) / nq);
      b.qty = nq;
    } else if (t.side === "SELL" && b.qty > 1e-9) {
      const closing = Math.min(q, b.qty);
      sells.push({ ts: t.ts, symbol: t.symbol, plPaise: Math.round((px - b.avg) * closing), avg: b.avg, px });
      b.qty -= closing;
      if (b.qty <= 1e-9) {
        trips.push({ symbol: t.symbol, openTs: b.openTs, closeTs: t.ts });
        b.qty = 0; b.openTs = null; b.buys = [];
      }
    }
  }
  return { book, sells, trips };
}

// Nifty's move over the same window, for context in the note.
function indexMove(indexBars, at, sessions) {
  const c = completedCloses(indexBars, at);
  if (c.length < sessions + 1) return null;
  return c[c.length - 1] / c[c.length - 1 - sessions] - 1;
}

// ---- PANIC SELL ---------------------------------------------------------------
// Selling a losing position right after a fall that is unusual FOR THIS STOCK.
// Gates: a real fall (the sell price vs the recent peak close, or vs the last
// close, beyond 2x the stock's typical move and at least 4% / 3%), sold below
// cost, at least a quarter of the position. Weighted down for long holds and
// partial sells. A sale at a profit after a dip is booking gains, not panic.
export function detectPanicSell(ctx) {
  const { trade, holdingBefore: hb } = ctx;
  if (trade?.side !== "SELL" || isFund(ctx.kind)) return null;
  if (!hb || !(hb.qty > 0) || !(hb.avgCostPaise > 0)) return null;
  const P = trade.pricePaise;
  if (!(P > 0)) return null;
  const closes = completedCloses(ctx.bars, trade.at);
  const vol = dailyVol(closes);
  if (!vol || !priceSane(P, closes)) return null;

  const plPct = P / hb.avgCostPaise - 1;
  if (plPct > -0.01) return null;
  const frac = Math.min(1, trade.qty / hb.qty);
  if (frac < 0.25) return null;

  const look = closes.slice(-5);
  let pi = 0;
  for (let i = 1; i < look.length; i++) if (look[i] >= look[pi]) pi = i;
  const sessions = look.length - pi;                  // peak close -> this sale
  // The fall the seller reacted to: peak close down to the lower of the last
  // close and the sale price (a small bounce before selling still counts).
  const drawdown = Math.min(P, closes[closes.length - 1]) / look[pi] - 1;
  const day = P / closes[closes.length - 1] - 1;
  const thrDD = Math.max(0.04, 2 * vol * Math.sqrt(sessions));
  const thrDay = Math.max(0.03, 2 * vol);
  const z = Math.max(-drawdown / thrDD, -day / thrDay);
  if (z < 1) return null;

  const { book } = ledger(ctx.history);
  const openTs = book[trade.symbol]?.qty > 0 ? book[trade.symbol].openTs : null;
  const holdDays = openTs ? (trade.at - openTs) / DAY : null;
  if (holdDays != null && holdDays > 365) return null;
  const wHold = holdDays == null || holdDays <= 30 ? 1 : Math.max(0.5, 1 - 0.5 * (holdDays - 30) / 150);
  const wFrac = 0.6 + 0.4 * clamp01((frac - 0.25) / 0.5);
  const severity = (0.45 + 0.55 * clamp01((z - 1) / 1.5)) * wHold * wFrac;

  const useDay = -day / thrDay >= -drawdown / thrDD;
  const nifty = indexMove(ctx.indexBars, trade.at, useDay ? 1 : sessions);
  return {
    bias: "panic_sell",
    severity,
    evidence: {
      symbol: trade.symbol,
      drop_pct: r1(useDay ? day : drawdown),
      drop_sessions: useDay ? 1 : sessions,
      typical_day_pct: r1(vol),
      times_typical: Math.round((useDay ? -day / vol : -drawdown / (vol * Math.sqrt(sessions))) * 10) / 10,
      pl_pct: r1(plPct),
      sold_pct: Math.round(frac * 100),
      holding_age_days: holdDays == null ? null : Math.round(holdDays),
      nifty_pct: nifty == null ? null : r1(nifty),
      // Older template fields.
      drop_3d_pct: r1(drawdown),
      drop_intraday_pct: r1(day),
    },
  };
}

// ---- FOMO -----------------------------------------------------------------------
// Opening a position after a run-up that is unusual for this stock: the buy
// price against the lowest close of the last 10 sessions, beyond 3x the
// typical 10-session move and at least 20%.
export function detectFOMO(ctx) {
  const { trade, holdingBefore: hb } = ctx;
  if (trade?.side !== "BUY" || isFund(ctx.kind)) return null;
  const P = trade.pricePaise;
  if (hb?.qty > 0 && hb.qty * hb.avgCostPaise >= 0.25 * trade.qty * P) return null;   // adding to a real position
  const closes = completedCloses(ctx.bars, trade.at);
  const vol = dailyVol(closes);
  if (!vol || !priceSane(P, closes)) return null;
  const win = closes.slice(-10);
  const low = Math.min(...win);
  const run = P / low - 1;
  const thr = Math.max(0.2, 3 * vol * Math.sqrt(10));
  if (run < thr) return null;
  return {
    bias: "fomo",
    severity: 0.45 + 0.55 * clamp01(run / thr - 1),
    evidence: {
      symbol: trade.symbol,
      run_up_pct: r1(run),
      sessions: win.length,
      typical_day_pct: r1(vol),
      nifty_pct: (() => { const m = indexMove(ctx.indexBars, trade.at, 10); return m == null ? null : r1(m); })(),
      run_up_pct_7d: r1(run),
    },
  };
}

// ---- PUMP CHASE -----------------------------------------------------------------
// Buying a stock already up sharply TODAY: buy price vs the last close, beyond
// 2.5x its typical daily move and at least 5%.
export function detectPumpChase(ctx) {
  const { trade } = ctx;
  if (trade?.side !== "BUY" || isFund(ctx.kind)) return null;
  const closes = completedCloses(ctx.bars, trade.at);
  const vol = dailyVol(closes);
  if (!vol || !priceSane(trade.pricePaise, closes)) return null;
  const day = trade.pricePaise / closes[closes.length - 1] - 1;
  const thr = Math.max(0.05, 2.5 * vol);
  if (day < thr) return null;
  return {
    bias: "pump_chase",
    severity: 0.45 + 0.55 * clamp01(day / thr - 1),
    evidence: { symbol: trade.symbol, intraday_gain_pct: r1(day), typical_day_pct: r1(vol) },
  };
}

// ---- ANCHORING (averaging down) -------------------------------------------------
// Buying more of a position that is well below what you paid, so the buy
// price becomes the "fair" price you wait to get back to. Gate: at least 8%
// (or 1.5x a month's typical move) below cost. Stronger with each earlier
// add that was also below cost.
export function detectAnchoring(ctx) {
  const { trade, holdingBefore: hb } = ctx;
  if (trade?.side !== "BUY" || isFund(ctx.kind)) return null;
  if (!hb || !(hb.qty > 0) || !(hb.avgCostPaise > 0)) return null;
  const below = trade.pricePaise / hb.avgCostPaise - 1;
  const vol = dailyVol(completedCloses(ctx.bars, trade.at)) || 0.02;
  const thr = Math.max(0.08, 1.5 * vol * Math.sqrt(20));
  if (below > -thr) return null;
  const { book } = ledger(ctx.history);
  const adds = (book[trade.symbol]?.buys || []).filter((b) => b.avgBefore && b.px < b.avgBefore * 0.97).length;
  return {
    bias: "anchoring",
    severity: Math.min(1, 0.45 + 0.3 * clamp01((-below / thr - 1) / 1.5) + 0.25 * clamp01(adds / 3)),
    evidence: { symbol: trade.symbol, anchor: "buy_price", below_cost_pct: r1(below), earlier_adds_below_cost: adds },
  };
}

// Value of a position at its real price, else at cost.
const posValue = (p) => Math.round((p.qty || 0) * (p.pricePaise || p.avgCostPaise || 0));

// ---- CONCENTRATION ----------------------------------------------------------------
// A buy that takes one stock to 40%+ of everything (cash included). Funds and
// ETFs are baskets, not single bets.
export function detectConcentration(ctx) {
  const { trade, portfolio } = ctx;
  if (trade?.side !== "BUY" || isBasket(ctx.kind) || !portfolio) return null;
  const pos = portfolio.positions?.[trade.symbol];
  if (!pos) return null;
  let total = portfolio.cashPaise || 0;
  for (const p of Object.values(portfolio.positions || {})) total += posValue(p);
  if (total <= 0) return null;
  const frac = posValue(pos) / total;
  if (frac < 0.4) return null;
  // Only the buy that pushed it over 40%, or added 10+ points: not every
  // top-up of a position that was already that big.
  const before = (posValue(pos) - Math.round(trade.qty * trade.pricePaise)) / total;
  if (before >= 0.4 && frac - before < 0.1) return null;
  return {
    bias: "concentration",
    severity: Math.min(1, 0.45 + 0.55 * clamp01((frac - 0.4) / 0.35)),
    evidence: { symbol: trade.symbol, concentration_pct: r1(frac) },
  };
}

// ---- SECTOR CONCENTRATION ------------------------------------------------------
// The buy that takes a sector to 60%+ of the money in stocks, across at
// least two stocks (one stock is the concentration detector's job), when
// stocks are at least a fifth of the portfolio.
export function detectSectorBias(ctx) {
  const { trade, portfolio } = ctx;
  if (trade?.side !== "BUY" || isBasket(ctx.kind) || !portfolio) return null;
  const sector = ctx.sector;
  if (!sector || /^(unknown|other)$/i.test(sector)) return null;
  let total = portfolio.cashPaise || 0, eq = 0, inSector = 0, n = 0;
  for (const p of Object.values(portfolio.positions || {})) {
    const v = posValue(p);
    total += v;
    if (isBasket(p.kind) || !p.sector || /^(unknown|other)$/i.test(p.sector)) continue;
    eq += v;
    if (p.sector === sector) { inSector += v; n++; }
  }
  if (total <= 0 || eq < 0.2 * total || n < 2) return null;
  const share = inSector / eq;
  if (share < 0.6) return null;
  const tv = Math.round(trade.qty * trade.pricePaise);
  if (eq - tv > 0 && (inSector - tv) / (eq - tv) >= 0.6) return null;   // was already there
  return {
    bias: "sector_concentration",
    severity: 0.45 + 0.55 * clamp01((share - 0.6) / 0.35),
    evidence: { top_sector: sector, sector_pct: r1(share), stocks_in_sector: n },
  };
}

// ---- DISPOSITION -----------------------------------------------------------------
// Selling a winner while holding losers, as a habit: this sale is at a profit,
// at least one other holding is 10%+ under water at a real price, and over 60
// days winners sold outnumber losers sold at least 2 to 1 (3+ winners).
export function detectDisposition(ctx) {
  const { trade, holdingBefore: hb, portfolio } = ctx;
  if (trade?.side !== "SELL" || !hb || !(hb.avgCostPaise > 0)) return null;
  if (trade.pricePaise < hb.avgCostPaise * 1.02) return null;
  const losers = [];
  for (const [sym, p] of Object.entries(portfolio?.positions || {})) {
    if (sym === trade.symbol || !(p.pricePaise > 0) || !(p.avgCostPaise > 0)) continue;
    const pct = p.pricePaise / p.avgCostPaise - 1;
    if (pct <= -0.1) losers.push({ symbol: sym, pct });
  }
  if (!losers.length) return null;
  const since = trade.at - 60 * DAY;
  const recent = ledger(ctx.history).sells.filter((s) => s.ts >= since);
  const winners = recent.filter((s) => s.plPaise > 0).length + 1;
  const losersSold = recent.filter((s) => s.plPaise < 0).length;
  const ratio = winners / Math.max(1, losersSold);
  if (winners < 3 || ratio < 2) return null;
  losers.sort((a, b) => a.pct - b.pct);
  return {
    bias: "disposition",
    severity: Math.min(1, 0.45 + 0.1 * Math.min(3, losers.length) + 0.1 * clamp01((ratio - 2) / 3) * 2),
    evidence: {
      winners_sold: winners, losers_sold: losersSold, losers_held: losers.length,
      worst_loser: losers[0].symbol, worst_loser_pct: r1(losers[0].pct),
      ratio: Math.round(ratio * 10) / 10,
    },
  };
}

// ---- CHURNING --------------------------------------------------------------------
// In and out of the same stock: the sell that completes a 3rd (6th, 9th)
// round trip in 30 days, each held under 5 days.
export function detectChurning(ctx) {
  const { trade } = ctx;
  if (trade?.side !== "SELL" || !trade.symbol) return null;
  const all = [...(ctx.history || []), { ...trade, ts: trade.at }];
  const since = trade.at - 30 * DAY;
  const quick = ledger(all).trips.filter((r) => r.symbol === trade.symbol && r.closeTs >= since && r.closeTs - r.openTs < 5 * DAY);
  // Only on the sell that closes the 3rd, 6th, 9th... quick round trip.
  if (quick.length < 3 || quick.length % 3 || quick[quick.length - 1].closeTs !== trade.at) return null;
  return {
    bias: "churning",
    severity: Math.min(1, 0.45 + 0.15 * (quick.length - 3)),
    evidence: { symbol: trade.symbol, round_trips_30d: quick.length },
  };
}

// ---- OVERTRADING -----------------------------------------------------------------
// The 10th (20th, 40th) trade placed by hand on one calendar day (IST), not
// on the account's first day. Orders the matcher filled later are not
// counted: they were decided earlier.
export function detectOvertrading(ctx) {
  const { trade } = ctx;
  if (!trade?.at) return null;
  const d = istDay(trade.at);
  const hist = ctx.history || [];
  // The first day is for trying things out.
  if (!hist.length || istDay(Math.min(...hist.map((t) => t.ts))) === d) return null;
  const n = 1 + hist.filter((t) => !t.auto && istDay(t.ts) === d).length;
  if (n !== 10 && n !== 20 && n !== 40) return null;     // once at each step, not on every trade
  return {
    bias: "overtrading",
    severity: Math.min(1, 0.45 + (n - 10) / 20),
    evidence: { trades_today: n, trades_24h: n },
  };
}

export const ALL_DETECTORS = [
  detectPanicSell, detectPumpChase, detectFOMO, detectAnchoring,
  detectConcentration, detectSectorBias, detectDisposition, detectChurning, detectOvertrading,
];

/** Every detector that fires, strongest first. A same-day spike and a run-up
 *  are one story: only the stronger of pump_chase / fomo is kept. */
export function evaluateTrade(ctx) {
  const t = ctx?.trade;
  if (!t || !(t.pricePaise > 0) || !(t.qty > 0) || !Number.isFinite(t.qty * t.pricePaise)) return [];
  const out = [];
  for (const det of ALL_DETECTORS) {
    try { const r = det(ctx); if (r) out.push(r); }
    catch (e) { (globalThis.console || {}).warn?.(`[bias] ${det.name} threw`, e); }
  }
  const pump = out.find((r) => r.bias === "pump_chase"), fomo = out.find((r) => r.bias === "fomo");
  const res = pump && fomo ? out.filter((r) => r !== (pump.severity >= fomo.severity ? fomo : pump)) : out;
  return res.sort((a, b) => b.severity - a.severity);
}

/** Show a note only from this severity up. */
export const NOTE_THRESHOLD = 0.5;
