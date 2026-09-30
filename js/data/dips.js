// =============================================================================
// HISTORICAL DIPS — "last N dips like this" statistics for the panic-sell
// pause and the stock page.
//
// The numbers are real: scripts/build_dip_stats.py measures them from daily
// closes (Yahoo Finance) since 2011 and writes js/data/dipStats.js. A dip
// starts on the first close X% below the running peak and recovers on the
// first close back at that peak; recoveryDays is the trading days between.
//
// This file used to generate these figures from a formula over hand-picked
// numbers while the UI called them history. Never go back to that: if a
// symbol has too few real dips, fall back to the Nifty 50, and if even that
// has none, return null so nothing is shown.
// =============================================================================

import { DIPS, NIFTY_COMPOSITE, DIP_SINCE } from "./dipStats.js";

const DIP_BUCKETS = [5, 7, 10, 15, 20];

export { DIPS, NIFTY_COMPOSITE };

/**
 * Look up the closest bucket AT OR BELOW the requested dip.
 * Returns the stats plus { bucket, source, symbol?, sinceYear } or null.
 */
export function lookupDip(symbol, drawdownPct) {
  const pct = Math.abs(drawdownPct);
  const bestBucket = DIP_BUCKETS.slice().reverse().find(b => pct >= b);
  if (!bestBucket) return null;

  const symStats = DIPS[symbol]?.[bestBucket];
  if (symStats && symStats.sampleSize >= 3) {
    return { ...symStats, bucket: bestBucket, source: "symbol", symbol, sinceYear: (DIP_SINCE[symbol] || "").slice(0, 4) };
  }
  const composite = NIFTY_COMPOSITE[bestBucket];
  if (!composite) return null;
  return { ...composite, bucket: bestBucket, source: "nifty", sinceYear: (DIP_SINCE.NIFTY50 || "").slice(0, 4) };
}
