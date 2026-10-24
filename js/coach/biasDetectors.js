// =============================================================================
// BIAS DETECTORS — the app's side of coach/biasCore.js (rewritten 24 Oct).
//
// The detectors themselves are pure functions in biasCore.js, tested against
// the real trade history. This file turns app state into their input: the
// user's earlier trades, holdings with REAL prices (else cost), sectors, and
// real daily bars from realCloses.js (never the synthetic chart walk). It is
// still the trusted layer: the coach only verbalises what these flag.
// =============================================================================

import { getState, getRealPricePaise, getReservedCashPaise } from "../state.js";
import { getInstrument } from "../data/universe.js";
import { realBars } from "../data/realCloses.js";
import { evaluateTrade, ALL_DETECTORS } from "./biasCore.js";

export { ALL_DETECTORS };

function kindOf(symbol) {
  if (!symbol || symbol.startsWith("MF_")) return "MF";
  const k = getInstrument(symbol)?.kind;
  return k === "MF" ? "MF" : k === "ETF" ? "ETF" : "STOCK";
}

const isAuto = (t) => (t.biasFlags || []).some((f) => (f?.bias || f) === "limit_order_filled");

function positionsOf(holdings, trade) {
  const out = {};
  for (const [sym, h] of Object.entries(holdings || {})) {
    if (!(h?.qty > 0)) continue;
    const inst = getInstrument(sym);
    out[sym] = {
      qty: h.qty,
      avgCostPaise: h.avgCostPaise,
      pricePaise: (trade && sym === trade.symbol && trade.pricePaise) || getRealPricePaise(sym) || null,
      sector: inst?.sector || null,
      kind: kindOf(sym),
    };
  }
  return out;
}

/**
 * Detector input for one trade.
 *  trade:          { symbol, side, qty, pricePaise, at? }
 *  holdingBefore:  the position before this trade (null if none)
 *  holdingsAfter:  every holding after it
 *  cashAfterPaise: cash (with cash held for open orders) after it
 *  excludeTxnId:   this trade's own ledger row, when it is already booked
 */
export function biasContext({ trade, holdingBefore, holdingsAfter, cashAfterPaise, excludeTxnId = null, state = getState() }) {
  const at = trade.at || Date.now();
  const history = (state.transactions || [])
    .filter((t) => t.id !== excludeTxnId && t.ts <= at)
    .map((t) => ({ symbol: t.symbol, side: t.side, qty: t.qty, pricePaise: t.pricePaise, ts: t.ts, auto: isAuto(t) }));
  return {
    trade: { ...trade, at },
    kind: kindOf(trade.symbol),
    sector: getInstrument(trade.symbol)?.sector || null,
    bars: realBars(trade.symbol),
    indexBars: null,
    holdingBefore: holdingBefore?.qty > 0 ? { qty: holdingBefore.qty, avgCostPaise: holdingBefore.avgCostPaise } : null,
    history,
    portfolio: { cashPaise: cashAfterPaise, positions: positionsOf(holdingsAfter, trade) },
  };
}

/** Run every detector; strongest first. */
export function runDetectors(ctx) {
  return ctx?.trade ? evaluateTrade(ctx) : [];
}

/**
 * A trade the user is placing now (not booked yet): a market order about to
 * go, an AMO or a limit order. Holdings and cash after it are worked out on a
 * copy of state.
 */
export function evaluateDecision({ symbol, side, qty, pricePaise }, state = getState()) {
  const before = state.holdings?.[symbol] || null;
  const after = { ...(state.holdings || {}) };
  const value = Math.round(qty * pricePaise);
  if (side === "BUY") {
    const q = (before?.qty || 0) + qty;
    after[symbol] = { ...(before || {}), qty: q, avgCostPaise: Math.round(((before?.qty || 0) * (before?.avgCostPaise || 0) + value) / q) };
  } else if (before) {
    const q = before.qty - Math.min(qty, before.qty);
    if (q > 1e-9) after[symbol] = { ...before, qty: q }; else delete after[symbol];
  }
  const cash = (state.portfolio?.cashPaise || 0) + getReservedCashPaise(state) + (side === "BUY" ? -value : value);
  return runDetectors(biasContext({ trade: { symbol, side, qty, pricePaise }, holdingBefore: before, holdingsAfter: after, cashAfterPaise: cash, state }));
}

/** The compact form stored on the trade (transactions.bias_flags). */
export const biasFlag = (r) => ({ bias: r.bias, severity: Math.round(r.severity * 100) / 100, evidence: r.evidence });
