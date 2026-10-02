// =============================================================================
// HISTORICAL ANALOG LOOKUP — "how did past falls like this one end?" for the
// panic-sell pause and the coach. Returns a citation-ready object or null
// (never cite if null).
//
// The current fall is measured from the stock's highest close on record, the
// same peak the statistics in dipStats.js use. It used to be measured from a
// 90-day high on the prices.js random walk, which compared unlike things and
// could describe a fall that never happened.
// =============================================================================

import { lookupDip, dipPeak } from "../data/dips.js";
import { realCloses } from "../data/realCloses.js";
import { getInstrument } from "../data/universe.js";

/**
 * @param {string} symbol
 * @param {number} [pricePaise] the live price, if the caller has it
 * Returns { symbol, instrument, drawdownPct, bucket, recoveryDays, sampleSize,
 *           falls, openDays, minRecoveryDays, maxRecoveryDays, source,
 *           sinceYear, peak?, peakDate?, asOf } | null.
 */
export function buildAnalogContext(symbol, pricePaise) {
  const inst = getInstrument(symbol);
  if (!inst) return null;
  const closes = realCloses(symbol);
  const price = (pricePaise > 0 ? pricePaise : closes[closes.length - 1]) || 0;
  if (!price) return null;

  // Own record: fall from the highest close on record.
  // No usable record: fall from the real one-year high, against Nifty figures.
  const peak = dipPeak(symbol);
  let drawdown;
  if (peak?.peak > 0) {
    drawdown = Math.min(0, price / 100 / peak.peak - 1);
  } else {
    if (closes.length < 20) return null;
    drawdown = Math.min(0, price / Math.max(...closes) - 1);
  }
  if (drawdown > -0.05) return null;                 // not meaningfully down
  const stat = lookupDip(symbol, drawdown * 100);
  if (!stat) return null;
  return {
    symbol,
    instrument: inst,
    drawdownPct: Math.round(Math.abs(drawdown) * 1000) / 10,
    bucket: stat.bucket,
    recoveryDays: stat.recoveryDays,
    sampleSize: stat.sampleSize,
    falls: stat.falls,
    openDays: stat.openDays,
    minRecoveryDays: stat.minRecoveryDays,
    maxRecoveryDays: stat.maxRecoveryDays,
    source: stat.source,
    sinceYear: stat.sinceYear,
    asOf: stat.asOf,
    peak: peak?.peak,
    peakDate: peak?.peakDate,
  };
}

/**
 * One honest sentence: how many falls recovered, how fast, and how many
 * have not. Never the median alone.
 */
export function formatAnalog(analog) {
  if (!analog) return null;
  const { instrument, bucket, recoveryDays, sampleSize, falls, openDays, source, maxRecoveryDays, sinceYear } = analog;
  const label = source === "nifty" ? "the Nifty 50 index" : instrument.name;
  const since = sinceYear ? ` since ${sinceYear}` : "";
  const intro = source === "nifty"
    ? `We don't have reliable long-term prices for ${instrument.name}, so for reference: `
    : "";
  const fell = `${label} has fallen ${bucket}% or more below a previous high ${falls} time${falls === 1 ? "" : "s"}${since}`;
  const back = sampleSize
    ? ` and climbed back ${sampleSize} of those times (median ${recoveryDays} trading days, slowest ${maxRecoveryDays})`
    : `, and has not yet climbed back from any of them`;
  const open = openDays && sampleSize
    ? `. The latest fall has not recovered after ${openDays} trading days`
    : openDays ? ` (the current one is ${openDays} trading days old)` : "";
  return `${intro}${fell}${back}${open}.`;
}
