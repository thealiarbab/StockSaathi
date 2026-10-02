// =============================================================================
// BIAS DETECTORS — Deterministic, pre-LLM. These are the TRUSTED LAYER.
// The coach NEVER decides if a bias applies; it only verbalises what
// these functions flagged. This keeps outputs anchored and SEBI-safe.
//
// Every detector is a pure function:
//   (userCtx, tradeCtx, priceCtx) => { bias, severity: 0-1, evidence } | null
//
// Higher severity = more confident the pattern is present.
// =============================================================================

import { getPriceAt, pctChange } from "../data/prices.js";
// Price-move detectors read REAL closes only (see realCloses.js); the
// prices.js series is a seeded walk and once produced invented "drops".
import { realCloses, real52w } from "../data/realCloses.js";
import { getInstrument } from "../data/universe.js";

// MFs trade at end-of-day NAV with no intraday price movement and no
// "panic sell" semantic — selling an MF is a redemption, settlement T+1
// to T+3, and the tiny daily NAV moves (0.01–0.5% typical) are nothing
// like the equity volatility these detectors are tuned for. Synthetic
// stub-walk closes for MFs would produce random false-positives
// (3-day stub drop ≥5% is easy to hit by chance). All bias detectors
// that key off `trade.symbol` skip MFs via this helper.
function _isMfSymbol(sym) {
  if (!sym || typeof sym !== "string") return false;
  if (sym.startsWith("MF_")) return true;
  const inst = getInstrument(sym);
  return inst?.kind === "MF";
}

// ---- PANIC SELL -----------------------------------------------------------
// Fires when: SELL event AND (recent sharp drop OR significant intraday drop)
//             AND holding was held briefly AND position was at a loss.
export function detectPanicSell({ trade, holding }) {
  if (!trade || trade.side !== "SELL") return null;
  if (_isMfSymbol(trade.symbol)) return null;   // MF redemption ≠ panic sell
  const sym = trade.symbol;
  const closes = realCloses(sym, 10);
  if (closes.length < 4) return null;

  const todayClose = closes[closes.length - 1];
  const threeDayAgo = closes[closes.length - 4];
  const threeDayPct = pctChange(threeDayAgo, todayClose);  // e.g. -0.08 = -8%
  const yesterdayClose = closes[closes.length - 2];
  const intradayPct = pctChange(yesterdayClose, todayClose);

  const sharp3Day = threeDayPct <= -0.05;          // ≥5% down over 3 sessions
  const sharpIntraday = intradayPct <= -0.03;      // ≥3% down today
  if (!sharp3Day && !sharpIntraday) return null;

  const holdingAgeDays = holding?.firstBoughtAt
    ? (Date.now() - holding.firstBoughtAt) / 86400000
    : 999;
  if (holdingAgeDays > 21) return null;            // held >3 weeks → not panic

  const plPct = holding
    ? pctChange(holding.avgCostPaise, todayClose)
    : 0;
  if (plPct >= -0.02) return null;                 // not actually down enough to qualify

  const drop = Math.max(Math.abs(threeDayPct), Math.abs(intradayPct));
  const severity = Math.min(1, drop / 0.10);       // 10% drop → severity 1

  return {
    bias: "panic_sell",
    severity,
    evidence: {
      drop_3d_pct: Math.round(threeDayPct * 1000) / 10,
      drop_intraday_pct: Math.round(intradayPct * 1000) / 10,
      holding_age_days: Math.round(holdingAgeDays),
      pl_pct: Math.round(plPct * 1000) / 10,
      symbol: sym,
    },
  };
}

// ---- FOMO / RECENCY -------------------------------------------------------
// BUY of a stock that's up ≥15% in 7 sessions AND user has no prior position.
export function detectFOMO({ trade, holdingBefore }) {
  if (!trade || trade.side !== "BUY") return null;
  if (holdingBefore) return null;                 // adding to existing = not FOMO
  if (_isMfSymbol(trade.symbol)) return null;     // MF NAV doesn't FOMO-spike

  const sym = trade.symbol;
  const closes = realCloses(sym, 8);
  if (closes.length < 8) return null;
  const weekAgo = closes[0];
  const today = closes[closes.length - 1];
  const pct = pctChange(weekAgo, today);

  // Raised threshold from 12% → 18% to cut false positives during normal
  // bull-run weeks (NSE large-caps often run 10–14% in good months).
  if (pct < 0.18) return null;
  const severity = Math.min(1, (pct - 0.18) / 0.18);

  return {
    bias: "fomo",
    severity: Math.max(0.4, severity),
    evidence: {
      run_up_pct_7d: Math.round(pct * 1000) / 10,
      symbol: sym,
    },
  };
}

// ---- CONCENTRATION RISK --------------------------------------------------
// Single holding >40% of portfolio value (post-trade).
export function detectConcentration({ holdingsAfter, portfolioValue, trade }) {
  if (!trade || trade.side !== "BUY") return null;
  if (portfolioValue <= 0) return null;
  const sym = trade.symbol;
  const h = holdingsAfter[sym];
  if (!h) return null;
  const curPx = getPriceAt(sym, 0);
  const holdValue = Math.round(h.qty * curPx);
  const frac = holdValue / portfolioValue;
  if (frac < 0.40) return null;

  const severity = Math.min(1, (frac - 0.35) / 0.30);
  return {
    bias: "concentration",
    severity,
    evidence: {
      concentration_pct: Math.round(frac * 1000) / 10,
      symbol: sym,
    },
  };
}

// ---- SECTOR / HOME BIAS --------------------------------------------------
// >80% of portfolio in one sector post-trade.
export function detectSectorBias({ holdingsAfter, portfolioValue }) {
  if (!holdingsAfter || portfolioValue <= 0) return null;
  const bySector = {};
  for (const [sym, h] of Object.entries(holdingsAfter)) {
    const inst = getInstrument(sym);
    if (!inst) continue;
    // Skip Tier-2 stub holdings — they all carry sector="Unknown" by
    // default, which would otherwise merge unrelated stocks into one
    // pseudo-sector and trigger a false sector_concentration signal.
    if (inst._stub) continue;
    // Skip MF holdings — MF rows carry `sector = category_bucket` ("Equity",
    // "Debt") which is a fund-type label not a sector. Counting an "Equity
    // Mutual Fund" toward the user's "Equity" sector concentration would
    // double-count diversified exposure as if it were a direct sector bet.
    // MFs are inherently diversified within their bucket — concentration
    // warnings should fire on direct stock holdings only.
    if (inst.kind === "MF") continue;
    const px = getPriceAt(sym, 0);
    const v = Math.round(h.qty * px);
    const key = inst.sector || "Unknown";
    bySector[key] = (bySector[key] || 0) + v;
  }
  const entries = Object.entries(bySector);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const [topSector, topValue] = entries[0];
  const frac = topValue / portfolioValue;
  if (frac < 0.55) return null;
  const severity = Math.min(1, (frac - 0.55) / 0.35);
  return {
    bias: "sector_concentration",
    severity: Math.max(0.3, severity),
    evidence: {
      top_sector: topSector,
      sector_pct: Math.round(frac * 1000) / 10,
    },
  };
}

// ---- DISPOSITION EFFECT ---------------------------------------------------
// 30-day rolling: winners_sold_rate > 2 * losers_sold_rate.
export function detectDisposition({ transactions }) {
  const cutoff = Date.now() - 30 * 86400000;
  const recent = transactions.filter(t => t.ts > cutoff);
  if (recent.length < 6) return null;

  let winnersSold = 0, losersSold = 0, winnersBought = 0, losersBought = 0;
  for (const t of recent) {
    // Use current price vs txn price as "was it a winner".
    // For BUY we look at whether the stock is up since the buy.
    const curPx = getPriceAt(t.symbol, 0);
    if (!curPx) continue;
    const wasUp = curPx > t.pricePaise;
    if (t.side === "SELL") (wasUp ? winnersSold++ : losersSold++);
    else (wasUp ? winnersBought++ : losersBought++);
  }

  if (winnersSold < 2 || losersSold + winnersSold < 4) return null;
  const ratio = winnersSold / Math.max(1, losersSold);
  if (ratio < 2) return null;
  return {
    bias: "disposition",
    severity: Math.min(1, (ratio - 2) / 3),
    evidence: { winners_sold: winnersSold, losers_sold: losersSold, ratio: Math.round(ratio * 10) / 10 },
  };
}

// ---- ANCHORING -----------------------------------------------------------
// BUY fill price within 2% of 52-week high or low.
export function detectAnchoring({ trade }) {
  if (!trade || trade.side !== "BUY") return null;
  if (_isMfSymbol(trade.symbol)) return null;   // 52W range from synthetic stub for MFs
  const range = real52w(trade.symbol);
  if (!range) return null;                      // no real history loaded
  const { hi, lo } = range;
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= 0 || lo <= 0) return null;
  const distHi = Math.abs(pctChange(hi, trade.pricePaise));
  const distLo = Math.abs(pctChange(lo, trade.pricePaise));
  if (distHi > 0.02 && distLo > 0.02) return null;
  const anchor = distHi < distLo ? "52w_high" : "52w_low";
  const dist = Math.min(distHi, distLo);
  // Scale severity by how close we are. At the exact anchor → 0.7, fading
  // linearly to 0.3 at the 2% boundary. Old code was a flat 0.4 regardless.
  const severity = Math.max(0.3, Math.min(0.8, 0.7 - (dist / 0.02) * 0.4));
  return {
    bias: "anchoring",
    severity,
    evidence: {
      anchor,
      symbol: trade.symbol,
      dist_pct: Math.round(dist * 1000) / 10,
    },
  };
}

// ---- CHURNING ------------------------------------------------------------
// ≥3 round-trips on same symbol in 30d.
export function detectChurning({ transactions, trade }) {
  if (!trade) return null;
  const cutoff = Date.now() - 30 * 86400000;
  const sym = trade.symbol;
  const recent = transactions.filter(t => t.ts > cutoff && t.symbol === sym);
  // Round trip heuristic: count alternating BUY/SELL pairs
  let roundTrips = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].side !== recent[i - 1].side) roundTrips++;
  }
  if (roundTrips < 3) return null;
  return {
    bias: "churning",
    severity: Math.min(1, roundTrips / 6),
    evidence: { round_trips_30d: roundTrips, symbol: sym },
  };
}

// ---- PUMP CHASE ----------------------------------------------------------
// BUY of a stock that gained >5% TODAY.
export function detectPumpChase({ trade }) {
  if (!trade || trade.side !== "BUY") return null;
  if (_isMfSymbol(trade.symbol)) return null;   // MF NAV doesn't pump intraday
  const closes = realCloses(trade.symbol, 2);
  if (closes.length < 2) return null;
  const intraday = pctChange(closes[0], closes[1]);
  if (intraday < 0.05) return null;
  return {
    bias: "pump_chase",
    severity: Math.min(1, intraday / 0.10),
    evidence: { intraday_gain_pct: Math.round(intraday * 1000) / 10, symbol: trade.symbol },
  };
}

// ---- OVERTRADING ---------------------------------------------------------
// More than 10 trades in a single day.
export function detectOvertrading({ transactions }) {
  const cutoff = Date.now() - 24 * 3600_000;
  const count = transactions.filter(t => t.ts > cutoff).length;
  if (count < 10) return null;
  return {
    bias: "overtrading",
    severity: Math.min(1, count / 20),
    evidence: { trades_24h: count },
  };
}

// ---------------------------------------------------------------------------
// ALL DETECTORS — run in order, return array of { bias, severity, evidence }
// ---------------------------------------------------------------------------
export const ALL_DETECTORS = [
  detectPanicSell,
  detectPumpChase,
  detectFOMO,
  detectAnchoring,
  detectConcentration,
  detectSectorBias,
  detectDisposition,
  detectChurning,
  detectOvertrading,
];

/**
 * Run all detectors on a context and return an array of triggered biases,
 * sorted by severity desc.
 */
export function runDetectors(ctx) {
  const results = [];
  for (const det of ALL_DETECTORS) {
    try {
      const r = det(ctx);
      if (r) results.push(r);
    } catch (e) {
      console.warn(`Detector ${det.name} threw:`, e);
    }
  }
  results.sort((a, b) => b.severity - a.severity);
  return results;
}
