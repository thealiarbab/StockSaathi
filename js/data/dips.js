// =============================================================================
// HISTORICAL DIPS — "last N dips like this" statistics for the panic-sell
// pause and the stock page.
//
// The numbers are real: scripts/build_dip_stats.py measures them from daily
// closes (Yahoo Finance) since 2011 for every stock that passes its data-
// quality gate (~1,700 stocks), and writes js/data/dipStats.js. A dip starts
// on the first close X% below the running peak and recovers on the first
// close back at that peak; recoveryDays is the trading days between.
//
// This file used to generate these figures from a formula over hand-picked
// numbers while the UI called them history. Never go back to that: if a
// symbol has too few real dips, fall back to the Nifty 50, and if even that
// has none, return null so nothing is shown.
//
// dipStats.js is ~240 KB, so it loads in the background instead of blocking
// the stock page; the pause it feeds only opens when the user sells, long
// after this has arrived. Until then lookupDip() returns null (no citation).
// =============================================================================

const DIP_BUCKETS = [5, 7, 10, 15, 20];

let DIPS = {}, NIFTY_COMPOSITE = {}, DIP_SINCE = {};
export const dipsReady = import("./dipStats.js")
  .then((m) => { DIPS = m.DIPS; NIFTY_COMPOSITE = m.NIFTY_COMPOSITE; DIP_SINCE = m.DIP_SINCE; })
  .catch(() => {});

// dipStats.js stores each bucket compactly as
// [median recovery days, recovered dips, fastest, slowest, still-open flag].
function unpack(row) {
  if (!row) return null;
  const [recoveryDays, sampleSize, minRecoveryDays, maxRecoveryDays, open] = row;
  return { recoveryDays, sampleSize, minRecoveryDays, maxRecoveryDays, open: !!open };
}

/**
 * Look up the closest bucket AT OR BELOW the requested dip.
 * Returns the stats plus { bucket, source, symbol?, sinceYear } or null.
 */
export function lookupDip(symbol, drawdownPct) {
  const pct = Math.abs(drawdownPct);
  const bestBucket = DIP_BUCKETS.slice().reverse().find(b => pct >= b);
  if (!bestBucket) return null;

  const symStats = unpack(DIPS[symbol]?.[bestBucket]);
  if (symStats && symStats.sampleSize >= 3) {
    return { ...symStats, bucket: bestBucket, source: "symbol", symbol, sinceYear: (DIP_SINCE[symbol] || "").slice(0, 4) };
  }
  const composite = unpack(NIFTY_COMPOSITE[bestBucket]);
  if (!composite) return null;
  return { ...composite, bucket: bestBucket, source: "nifty", sinceYear: (DIP_SINCE.NIFTY50 || "").slice(0, 4) };
}
