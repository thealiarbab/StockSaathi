// =============================================================================
// ORCHESTRATOR — Receives an event + context, runs bias detectors, selects
// the right template, optionally augments via LLM, filters output, and
// returns a coach message ready to be persisted and rendered.
//
// Deterministic layer ALWAYS runs first. The LLM is optional flavor.
// =============================================================================

import { runDetectors } from "./biasDetectors.js";
import { buildAnalogContext } from "./historicalAnalog.js";
import { resolveTemplate, makeTick } from "./templates.js";
import { filterOutput, safeFallback } from "./outputFilter.js";
import { getInstrument } from "../data/universe.js";
import { getPriceAt } from "../data/prices.js";
import { getState } from "../state.js";
import { callExternalLlm } from "./llmBridge.js";
import { primeRealCloses } from "../data/realCloses.js";

/**
 * @param {Object} event — { type, ...fields }
 * @returns {Object} coachMessage — { id, ts, eventType, payload, model, biases[] }
 */
export async function coach(event) {
  const s = getState();

  // Price-move detectors only read real closes; load them first.
  if (event.symbol && !String(event.type || "").startsWith("CRASH_")) await primeRealCloses(event.symbol);

  // Build a unified context
  const ctx = buildContext(event, s);

  // Run deterministic biases
  const biases = runDetectors(ctx.detectorCtx);
  const biasEvidence = {};
  for (const b of biases) biasEvidence[b.bias] = b;

  // Determine template key
  const templateKey = pickTemplateKey(event, biases);

  // Instrument + analog (used by tick builder).
  //
  // event.instrument takes precedence when callers supply one. The
  // stockDetail page passes a merged instrument with liveFundamentals
  // patched in (`{ ...inst, pe: liveFundamentals.pe_ratio, marketCap:
  // liveFundamentals.market_cap, sector: liveSector }`), so the coach
  // template gets the real PE/MarketCap/sector — not the universe's
  // null PE that produces "P/E is —, which means investors are paying
  // ₹— for every ₹1 of annual earnings." Pre-fix this branch always
  // overwrote the merged instrument with a fresh getInstrument()
  // lookup, throwing away the live-fundamentals merge.
  const instrument = event.instrument || (event.symbol ? getInstrument(event.symbol) : null);
  const analog = event.symbol ? buildAnalogContext(event.symbol, event.pricePaise || event.trade?.pricePaise) : null;

  const tick = makeTick({
    trade: ctx.trade,
    instrument,
    analog,
    biasEvidence,
    holding: ctx.holding,
  });

  // Pull through any custom event fields (crash replay uses delta/indexDrop/
  // recoveryDays/crashTitle/heldBeat/days; intervention uses dropText; etc.).
  // Only fields not already set by makeTick.
  for (const k of Object.keys(event || {})) {
    if (k === "type") continue;
    if (tick[k] == null && event[k] != null) tick[k] = event[k];
  }
  if (typeof tick.heldBeat === "undefined" && typeof event.delta === "number") {
    tick.heldBeat = event.delta > 0;
  }

  // 1. Template pass (primary)
  let payload = resolveTemplate(templateKey, { tick, event }) ||
                resolveTemplate(event.type, { tick, event }) ||
                safeFallback();

  // Attach citations if analog was used
  if (analog && !payload.citations.length) {
    payload.citations = [
      `${analog.source === "nifty" ? "Nifty 50" : analog.symbol} ${analog.bucket}% falls`,
      `${analog.sampleSize} of ${analog.falls} recovered`,
      analog.recoveryDays != null ? `Median recovery: ${analog.recoveryDays}d` : "None recovered yet",
    ];
  }
  if (biases.length) {
    payload.citations = [...(payload.citations || []), ...biases.map(b => `${b.bias}: ${(b.severity * 100).toFixed(0)}% conf`)];
  }

  // Filter (block SEBI-actionable, truncate, validate)
  const filtered = filterOutput(payload);
  if (!filtered.ok) {
    console.warn("Coach output filtered:", filtered.reason, payload);
    payload = safeFallback();
  } else {
    payload = filtered.payload;
  }

  // 2. Optional LLM augmentation — ONLY if API key provided.
  // Fire-and-forget; does not block the primary render.
  let model = "template";
  if (s.settings.llmApiKey) {
    try {
      const llmText = await callExternalLlm(s.settings.llmApiKey, {
        event, tick, biases, analog, payload,
      });
      if (llmText) {
        const filteredLlm = filterOutput({
          ...payload,
          reflection: llmText,
        });
        if (filteredLlm.ok) {
          payload = filteredLlm.payload;
          model = "llm";
        }
      }
    } catch (e) {
      console.warn("LLM augment failed (ok, used template):", e);
    }
  }

  // Build the coach message
  return {
    id: `cm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    ts: Date.now(),
    eventType: event.type,
    payload,
    model,
    biases,
    triggerSymbol: event.symbol || null,
  };
}

// ---- Helpers -------------------------------------------------------------
function buildContext(event, s) {
  const ctx = { event, state: s, detectorCtx: {} };

  if (event.type === "BUY" || event.type === "SELL") {
    ctx.trade = {
      symbol: event.symbol,
      side: event.type,
      qty: event.qty,
      pricePaise: event.pricePaise,
    };
    const holdingBefore = s.holdings[event.symbol];
    ctx.holding = holdingBefore;
    // holdingsAfter snapshot (for concentration etc.)
    const holdingsAfter = applyHypotheticalTrade(s.holdings, ctx.trade, s.portfolio.cashPaise);
    ctx.detectorCtx = {
      trade: ctx.trade,
      holding: holdingBefore,
      holdingBefore,
      holdingsAfter,
      portfolioValue: getPortfolioValueForCtx(s.portfolio.cashPaise, holdingsAfter),
      transactions: s.transactions,
    };
  } else {
    ctx.detectorCtx = {
      transactions: s.transactions,
      holdingsAfter: s.holdings,
      portfolioValue: getPortfolioValueForCtx(s.portfolio.cashPaise, s.holdings),
    };
  }
  return ctx;
}

function applyHypotheticalTrade(holdings, trade, cashPaise) {
  if (!trade) return holdings;
  const { symbol, side, qty, pricePaise } = trade;
  const cur = holdings[symbol];
  if (side === "BUY") {
    const newQty = (cur?.qty || 0) + qty;
    return {
      ...holdings,
      [symbol]: {
        qty: newQty,
        avgCostPaise: cur
          ? Math.round((cur.avgCostPaise * cur.qty + qty * pricePaise) / newQty)
          : pricePaise,
        firstBoughtAt: cur?.firstBoughtAt || Date.now(),
      },
    };
  } else {
    if (!cur) return holdings;
    const remaining = cur.qty - qty;
    if (remaining <= 1e-9) {
      const { [symbol]: _, ...rest } = holdings;
      return rest;
    }
    return { ...holdings, [symbol]: { ...cur, qty: remaining } };
  }
}

function getPortfolioValueForCtx(cashPaise, holdings) {
  // Use current price where available; fall back to avg cost.
  let total = cashPaise;
  for (const [sym, h] of Object.entries(holdings)) {
    const cur = getPriceAt(sym, 0);
    total += Math.round(h.qty * (cur || h.avgCostPaise));
  }
  return total;
}

function pickTemplateKey(event, biases) {
  if (biases.length && (event.type === "BUY" || event.type === "SELL")) {
    const top = biases[0];
    return `${event.type}_${top.bias}`;
  }
  // First trade
  if (event.isFirstTrade) return "FIRST_TRADE";
  return event.type;
}
