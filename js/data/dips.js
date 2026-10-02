// =============================================================================
// HISTORICAL DIPS — how past falls of a stock recovered, for the panic-sell
// pause and the stock page.
//
// The numbers are real: scripts/build_dip_stats.py measures them from daily
// closes (Yahoo Finance) since 2011 for every stock that passes its data-
// quality gate (~2,000 stocks), and writes js/data/dipStats.js. A dip starts
// on the first close X% below the running peak (the highest close so far)
// and recovers on the first close back at that peak.
//
// ALWAYS show the falls that have NOT recovered next to the median of the ones
// that did. An earlier version showed only the median: JUSTDIAL read "median
// recovery 12 days" while 65% below its 2014 high, eight years later.
//
// This file once generated these figures from a formula over hand-picked
// numbers while the UI called them history. Never go back to that. A symbol
// with no usable price history falls back to the Nifty 50, labelled as such;
// if even that is missing, return null so nothing is shown.
//
// dipStats.js is large, so it loads in the background; the pause it feeds only
// opens when the user sells, long after this has arrived. Until then
// lookupDip() returns null (no citation).
// =============================================================================

const DIP_BUCKETS = [5, 7, 10, 15, 20];

let DIPS = {}, NIFTY_COMPOSITE = {}, DIP_SINCE = {}, DIP_NOW = {};
export const dipsReady = import("./dipStats.js")
  .then((m) => {
    DIPS = m.DIPS; NIFTY_COMPOSITE = m.NIFTY_COMPOSITE; DIP_SINCE = m.DIP_SINCE; DIP_NOW = m.DIP_NOW || {};
  })
  .catch(() => {});

// dipStats.js stores each bucket compactly as
// [median recovery days, recovered dips, fastest, slowest, days the open dip has lasted].
function unpack(row) {
  if (!row) return null;
  const [recoveryDays, sampleSize, minRecoveryDays, maxRecoveryDays, openDays] = row;
  return { recoveryDays, sampleSize, minRecoveryDays, maxRecoveryDays, openDays: openDays || 0 };
}

// [highest close, its date, last close, last date, start of the open 10% dip]
function unpackNow(row) {
  if (!row) return null;
  const [peak, peakDate, last, lastDate] = row;
  return { peak, peakDate, last, lastDate };
}

/** The highest close on record (rupees) and its date, or null. */
export function dipPeak(symbol) {
  return unpackNow(DIP_NOW[symbol]);
}

/**
 * Stats for the closest bucket AT OR BELOW the requested fall (a positive or
 * negative percentage, e.g. -12 or 12). The fall should be measured from the
 * same peak the stats use: see dipPeak().
 * Returns { recoveryDays, sampleSize, minRecoveryDays, maxRecoveryDays,
 * openDays, falls, bucket, source, symbol?, sinceYear, asOf } or null.
 */
export function lookupDip(symbol, drawdownPct) {
  const pct = Math.abs(drawdownPct);
  const bestBucket = DIP_BUCKETS.slice().reverse().find(b => pct >= b);
  if (!bestBucket) return null;

  const own = DIPS[symbol];
  if (own) {
    // The stock has usable history. Use it even when it rarely recovered:
    // that is the most important thing to show someone about to sell.
    const st = unpack(own[bestBucket]);
    if (!st) return null;   // never fell this far before
    return {
      ...st, falls: st.sampleSize + (st.openDays ? 1 : 0), bucket: bestBucket, source: "symbol", symbol,
      sinceYear: (DIP_SINCE[symbol] || "").slice(0, 4), asOf: DIP_NOW[symbol]?.[3] || "",
    };
  }
  const composite = unpack(NIFTY_COMPOSITE[bestBucket]);
  if (!composite) return null;
  return {
    ...composite, falls: composite.sampleSize + (composite.openDays ? 1 : 0), bucket: bestBucket,
    source: "nifty", sinceYear: (DIP_SINCE.NIFTY50 || "").slice(0, 4), asOf: DIP_NOW.NIFTY50?.[3] || "",
  };
}
