// =============================================================================
// REAL CLOSES — the last year of real daily prices for a stock, for the bias
// detectors and the panic-sell pause.
//
// prices.js serves a SEEDED RANDOM WALK anchored to today's price (it exists
// so sparklines are never blank). The detectors used to read it, so "down 8%
// in three sessions" in the panic-sell pause could describe a fall that never
// happened. Detectors must read from here instead: call primeRealCloses()
// before running them, and treat an empty result as "no evidence" (return
// null), never as a reason to fall back to the walk.
//
// Prices are PAISE, oldest first, same as /api/history.
// =============================================================================

import { getHistory } from "./marketData.js";

const TTL_MS = 30 * 60 * 1000;
const _real = new Map();   // symbol -> { ts, ohlc }

// Mutual funds (MF_<code>) and crash-replay ids (COVID_2020) are not tickers;
// no listed stock symbol contains an underscore.
function _isMf(symbol) {
  return !symbol || String(symbol).includes("_");
}

/** Fetch (or reuse) a year of real daily bars. Resolves to the bars or null. */
// One request per symbol at a time. The stock page starts this when it opens
// so a Sell tap finds it done; a tap that lands mid-fetch joins that fetch
// instead of starting a second one.
const _inflight = new Map();

export async function primeRealCloses(symbol) {
  if (_isMf(symbol)) return null;
  const hit = _real.get(symbol);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.ohlc;
  if (_inflight.has(symbol)) return _inflight.get(symbol);
  const p = (async () => {
    try {
      const h = await getHistory(symbol, "1y", "1d");
      // getHistory() substitutes a synthetic series when Yahoo fails; never use that.
      if (h?.source !== "yahoo" || !Array.isArray(h.ohlc) || h.ohlc.length < 2) return null;
      _real.set(symbol, { ts: Date.now(), ohlc: h.ohlc });
      return h.ohlc;
    } catch {
      return null;
    } finally {
      _inflight.delete(symbol);
    }
  })();
  _inflight.set(symbol, p);
  return p;
}

/** Last n real closes (paise), or [] if this symbol was not primed. */
export function realCloses(symbol, n = null) {
  const bars = _real.get(symbol)?.ohlc || [];
  const closes = bars.map((k) => k.c);
  return n != null ? closes.slice(-n) : closes;
}

/** Real 52-week high/low (paise), or null if not primed. */
export function real52w(symbol) {
  const bars = _real.get(symbol)?.ohlc;
  if (!bars?.length) return null;
  let hi = -Infinity, lo = Infinity;
  for (const k of bars) {
    if (k.h > hi) hi = k.h;
    if (k.l < lo) lo = k.l;
  }
  return { hi, lo };
}
