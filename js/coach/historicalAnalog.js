// =============================================================================
// HISTORICAL ANALOG LOOKUP — For "last N dips like this" coach citations.
// Always returns a citation-ready object or null (never cite if null).
// =============================================================================

import { lookupDip } from "../data/dips.js";
import { getDrawdownFromHigh, get52wRange, getPriceAt, pctChange } from "../data/prices.js";
import { getInstrument } from "../data/universe.js";

/**
 * For a given symbol at its current price, look up historical dip recovery.
 * Returns: { recoveryDays, sampleSize, source, bucket, dropPct, instrument }
 *          | null if insufficient data.
 */
export function buildAnalogContext(symbol) {
  const inst = getInstrument(symbol);
  if (!inst) return null;
  const drawdown = getDrawdownFromHigh(symbol, 90); // negative
  if (drawdown > -0.03) return null;                // not meaningfully down
  const stat = lookupDip(symbol, drawdown);
  if (!stat) return null;
  return {
    symbol,
    instrument: inst,
    drawdownPct: Math.round(Math.abs(drawdown) * 1000) / 10,
    bucket: stat.bucket,
    recoveryDays: stat.recoveryDays,
    sampleSize: stat.sampleSize,
    minRecoveryDays: stat.minRecoveryDays,
    maxRecoveryDays: stat.maxRecoveryDays,
    source: stat.source,
    sinceYear: stat.sinceYear,
  };
}

/**
 * Human-language formatting of the analog.
 */
export function formatAnalog(analog) {
  if (!analog) return null;
  const { instrument, bucket, recoveryDays, sampleSize, source, maxRecoveryDays, sinceYear } = analog;
  const label = source === "nifty" ? "the Nifty 50 index" : instrument.name;
  const since = sinceYear ? ` since ${sinceYear}` : "";
  return `In ${sampleSize} dips of ${bucket}% or more on ${label}${since} that have recovered, prices got back to their prior high in a median of ${recoveryDays} trading days (slowest: ${maxRecoveryDays} days).`;
}
