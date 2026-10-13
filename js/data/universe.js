// =============================================================================
// UNIVERSE — compatibility shim. Actual data lives in curated.js (~100 hand-
// tagged rows, Tier 1) and universeFull.json (~2,200 NSE rows, Tier 2).
// The loader (universeLoader.js) owns merging and getInstrument resolution.
// =============================================================================

export {
  STOCKS,
  MUTUAL_FUNDS,
  INSTRUMENTS,
  SECTORS,
  INSTRUMENT_BY_SYMBOL,
  ONBOARDING_PORTFOLIOS,
  getInstrument,
  canonicalSymbol,
  ensureUniverseLoaded,
  ensureMfUniverseLoaded,
  getAllInstruments,
  getAllSectors,
  getMfCategoryBuckets,
  getCanonicalCategory,
  getCanonicalCategoryCounts,
} from "./universeLoader.js";
