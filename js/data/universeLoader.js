// =============================================================================
// UNIVERSE LOADER — full Tier-2 universeFull.json + featured-symbol projection.
//
// Zero hand-typed data. Every field comes from automated builds:
//   - Symbol list, name, sector, series, ISIN: build-universe.mjs (NSE +
//     NiftyIndices CSVs) → universeFull.json
//   - market_cap / PE / PB / beta / divYield / EPS: /api/fundamentals
//     (Yahoo crumb + Tickertape, cached in Supabase fundamentals_cache)
//   - Price / OHLC / 52W: /api/quote, /api/history (Yahoo v8/chart)
//
// Sync API (getInstrument / STOCKS / INSTRUMENTS / SECTORS / INSTRUMENT_BY_SYMBOL)
// stays valid from module-load onwards. Before universeFull.json lands,
// FEATURED_SYMBOLS resolve to minimal stubs; after the JSON loads, the
// projection upgrades to full Tier-2 rows + ss:universe-loaded fires so
// pages can re-render with the proper sector / risk / industry tags.
// =============================================================================

import { FEATURED_SYMBOLS, FEATURED_MF_CODES, PLACEHOLDER_MFS, ONBOARDING_PORTFOLIOS } from "./curated.js";

export { ONBOARDING_PORTFOLIOS, FEATURED_SYMBOLS, FEATURED_MF_CODES };

// ── Mutable module-scoped state ─────────────────────────────────────────────
let _fullBySymbol = null;          // populated after ensureUniverseLoaded resolves
let _mfBySymbol = null;            // populated after AMFI mfFull.json lands
let _mergedBySymbol = null;        // lazy: full ∪ MF placeholders ∪ AMFI MFs
let _sectorsCache = null;          // lazy: union of sectors
let _categoriesCache = null;       // lazy: MF category bucket list
let _loadPromise = null;           // de-dupes concurrent ensureUniverseLoaded calls
let _mfLoadPromise = null;         // de-dupes concurrent ensureMfUniverseLoaded calls

// ── Bootstrap stubs (until universeFull.json lands) ────────────────────────
// At cold load FEATURED_SYMBOLS resolve to minimal stubs. Once the JSON
// loads they get replaced with full Tier-2 rows. Kind defaults to EQUITY.
function _bareStub(symbol, kind = "EQUITY") {
  return {
    symbol,
    name: symbol,
    sector: kind === "MF" ? null : "Unknown",
    kind,
    risk: "med",
    logo: symbol.slice(0, 3),
    price: null,
    marketCap: null,
    pe: null,
    pb: null,
    divYield: null,
    beta: null,
    _stub: true,
  };
}

const _placeholderMfsByS = Object.fromEntries(
  PLACEHOLDER_MFS.map(m => [m.symbol, { ...m, kind: "MF", _placeholder: true }])
);

// ── Public sync exports (live bindings — re-read after universe-loaded) ─────
// `let` so we can swap in upgraded values when Tier-2 lands.

/** Featured-symbol projection. Initially stubs; upgraded to full Tier-2 rows
 *  after universeFull.json loads. */
export let STOCKS = FEATURED_SYMBOLS.map(s => _bareStub(s, "EQUITY"));

/** Mutual funds — placeholders until Landing G ships AMFI's full ~5,000-
 *  scheme catalog. */
export let MUTUAL_FUNDS = PLACEHOLDER_MFS.map(m => ({ ...m, kind: "MF" }));

/** Combined featured + placeholder MFs. Equivalent to old `INSTRUMENTS`. */
export let INSTRUMENTS = [...STOCKS, ...MUTUAL_FUNDS];

/** Symbol → instrument map. Live binding so callers reading after
 *  universe-loaded see fresh data. */
export let INSTRUMENT_BY_SYMBOL = Object.fromEntries(
  INSTRUMENTS.map(i => [i.symbol, i])
);

/** Sector list for the curated view (featured + MF placeholders).
 *  After Tier-2 loads, getAllSectors() returns the broader union. */
export let SECTORS = [...new Set(STOCKS.map(s => s.sector).filter(s => s && s !== "Unknown"))].sort();

// ── Resolve a single symbol to its richest available instrument record ──────
export function getInstrument(symbol) {
  if (!symbol || typeof symbol !== "string") return null;
  // 1) AMFI catalog (MF_<scheme code> primary key — wins over the placeholder
  //    list when both are loaded, since AMFI ships richer metadata).
  if (_mfBySymbol && _mfBySymbol[symbol]) return _mfBySymbol[symbol];
  // 2) Tier 2 equity universe (lazy-loaded NSE + ETF rows).
  if (_fullBySymbol && _fullBySymbol[symbol]) return _fullBySymbol[symbol];
  // 3) MF placeholder (kept for ONBOARDING_PORTFOLIOS symbols only — these
  //    are the legacy 10 hand-typed scheme codes that onboarding starter
  //    portfolios reference. Real AMFI codes use the (1) branch.)
  if (_placeholderMfsByS[symbol]) return _placeholderMfsByS[symbol];
  // 4) Stub — pages render stub-tolerant skeletons + kick Tier-3 enrichment
  return _bareStub(symbol, symbol.startsWith("MF_") ? "MF" : "EQUITY");
}

// Resolve the current immutable URL via the meta index. The meta file is
// served with max-age=300 (small + churn-tolerant), and points at the
// content-addressed `<name>.<sha8>.json` which is served with
// max-age=31536000, immutable. This pattern eliminates the 304 round-trip
// that was burning ~190 ms per cold load while letting the universe
// content rev whenever the build script regenerates it.
//
// Falls back to the legacy un-hashed URL if the meta fetch fails (during
// the rolling deploy where the meta is updated before the hashed file
// reaches the edge cache, or for older clients pre-Landing-G).
async function _resolveImmutableUrl(name) {
  try {
    const metaRes = await fetch(`./js/data/${name}.meta.json`, { cache: "default" });
    if (!metaRes.ok) return `./js/data/${name}.json`;
    const meta = await metaRes.json();
    if (meta && typeof meta.sha8 === "string" && /^[0-9a-f]{8}$/.test(meta.sha8)) {
      return `./js/data/${name}.${meta.sha8}.json`;
    }
  } catch (_) {}
  return `./js/data/${name}.json`;
}

// ── Lazy load Tier-2 + upgrade the bootstrap stubs ──────────────────────────
export function ensureUniverseLoaded() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const url = await _resolveImmutableUrl("universeFull");
      const res = await fetch(url, { cache: "default" });
      if (!res.ok) return false;
      const rows = await res.json();
      if (!Array.isArray(rows)) return false;

      const byS = {};
      for (const r of rows) {
        if (!r || !r.symbol) continue;
        byS[r.symbol] = {
          kind: r.kind || "EQUITY",
          // No hand-typed defaults — these come from /api/fundamentals
          // when the user opens a stock detail page or scrolls a card
          // into view. Cards render skeleton until live data lands.
          price: null,
          marketCap: null,
          pe: null,
          pb: null,
          divYield: null,
          beta: null,
          logo: r.symbol.slice(0, 3),
          ...r,
        };
      }
      _fullBySymbol = byS;
      _mergedBySymbol = null;
      _sectorsCache = null;

      // Upgrade the boot-stub exports in place — live bindings means importers
      // see the new arrays on next access.
      STOCKS = FEATURED_SYMBOLS
        .map(s => byS[s] || _bareStub(s, "EQUITY"));
      INSTRUMENTS = [...STOCKS, ...MUTUAL_FUNDS];
      INSTRUMENT_BY_SYMBOL = Object.fromEntries(
        INSTRUMENTS.map(i => [i.symbol, i]).concat(
          // Also expose every Tier-2 row for direct lookup
          Object.entries(byS)
        )
      );
      SECTORS = [...new Set(
        STOCKS.map(s => s.sector).filter(s => s && s !== "Unknown")
      )].sort();

      // Notify subscribers (stocks.js, stockDetail.js, coach panels) so they
      // can re-render with proper sectors + Tier-2 names.
      try {
        window.dispatchEvent(new CustomEvent("ss:universe-loaded", { detail: { count: rows.length } }));
      } catch (_) {}
      return true;
    } catch (_) {
      return false;
    }
  })();
  return _loadPromise;
}

// ── Lazy load AMFI mutual-fund universe ─────────────────────────────────────
// Separate from ensureUniverseLoaded so the equity grid paints fast — MFs
// are ~5.7 MB raw / ~600 KB brotli and only matter when the user clicks the
// Mutual Funds tab. stocks.js calls this on tab activation.
export function ensureMfUniverseLoaded() {
  if (_mfLoadPromise) return _mfLoadPromise;
  _mfLoadPromise = (async () => {
    try {
      const url = await _resolveImmutableUrl("mfFull");
      const res = await fetch(url, { cache: "default" });
      if (!res.ok) return false;
      const rows = await res.json();
      if (!Array.isArray(rows)) return false;
      const byS = {};
      for (const r of rows) {
        if (!r || !r.symbol) continue;
        byS[r.symbol] = {
          // Card / detail components share the EQUITY shape; map AMFI fields
          // onto the same property names (sector → category_bucket so the
          // sector pill row doesn't drown in 47 distinct categories) so
          // filterPipelines / getCloses don't need MF-specific branches.
          kind: "MF",
          // NAV-as-paise so synthMFQuote, getPriceAt, getHoldingsValue and the
          // generateSeries stub-walk anchor all read the right base. Without
          // this, every MF flowed through `Math.round(null * drift)` which JS
          // coerces to 0 — visible to users as "₹0.00" in the price header,
          // wrong portfolio valuations, and a chart anchored to a random
          // synthetic walk (₹50–5000) instead of the real NAV (e.g. ₹1006
          // for Money Market). Audited and root-caused 2026-04-25.
          price: r.nav != null ? Math.round(r.nav * 100) : null,
          marketCap: null,
          pe: null,
          pb: null,
          divYield: null,
          beta: null,
          logo: r.amc ? r.amc.split(/\s+/).slice(0, 2).map(w => w[0]).join("").slice(0, 3).toUpperCase() : "MF",
          sector: r.category_bucket || "Other",   // Equity / Debt / Hybrid / Index / etc.
          ...r,
        };
      }
      _mfBySymbol = byS;
      _mergedBySymbol = null;       // invalidate so getAllInstruments rebuilds
      _categoriesCache = null;
      try {
        window.dispatchEvent(new CustomEvent("ss:mf-universe-loaded", { detail: { count: rows.length } }));
      } catch (_) {}
      return true;
    } catch (_) {
      return false;
    }
  })();
  return _mfLoadPromise;
}

// ── Full merged view (Tier-2 + AMFI MFs + legacy MF placeholders) ──────────
export function getAllInstruments() {
  if (!_fullBySymbol && !_mfBySymbol) return INSTRUMENTS;
  if (_mergedBySymbol) return Object.values(_mergedBySymbol);
  // ORDER MATTERS, and it used to be wrong.
  //
  // _placeholderMfsByS was spread LAST, so the 8 legacy placeholder funds in
  // curated.js overrode the real AMFI catalogue for their symbols. Those
  // placeholders carry no NAV, so the winning entry was unpriceable — while
  // still appearing in search and therefore being buyable.
  //
  // That is not hypothetical. One user holds 56.86 units of MF_NIPPON_GOLD
  // bought 2026-04-22 (cost basis Rs 17,984). It is in neither quote_cache
  // nor mf_master, so apply_trade raises 'no price available' and they cannot
  // sell it. Same failure class as the order-rot incident in AGENTS.md.
  //
  // Placeholders now go FIRST, making them a FALLBACK that real data
  // overrides, which is what "placeholder" was always supposed to mean. They
  // stay in the merge so existing holdings still resolve to a name rather
  // than rendering as a bare symbol.
  const merged = {
    ..._placeholderMfsByS,         // legacy starter-portfolio codes (fallback only)
    ...(_fullBySymbol || {}),
    ...(_mfBySymbol || {}),
  };
  _mergedBySymbol = merged;
  return Object.values(merged);
}

// Full sector list — sorted, deduped, ETF rows excluded so the sector-pill
// row doesn't render a literal "ETF" button (ETFs get their own kind pill).
// MFs are also excluded — when the Mutual Funds tab is active stocks.js
// switches to category-bucket pills via getMfCategoryBuckets().
export function getAllSectors() {
  if (!_fullBySymbol) return SECTORS;
  if (_sectorsCache) return _sectorsCache;
  const set = new Set();
  for (const r of Object.values(_fullBySymbol)) {
    if (r.sector && r.kind !== "ETF" && r.kind !== "MF" && r.sector !== "Unknown") set.add(r.sector);
  }
  _sectorsCache = [...set].sort();
  return _sectorsCache;
}

// MF category buckets (Equity / Index / Hybrid / Debt / Solution / Commodity
// / FoF). Used by the Mutual Funds tab in stocks.js — replaces the sector
// pill row when filter.kind === "MF". Excludes "Other" since the bucketFor
// build step normalises everything into one of the named buckets now.
export function getMfCategoryBuckets() {
  if (!_mfBySymbol) return [];
  if (_categoriesCache) return _categoriesCache;
  const order = ["Equity", "Index", "Hybrid", "Debt", "Solution", "Commodity", "FoF"];
  const present = new Set();
  for (const r of Object.values(_mfBySymbol)) {
    if (r.category_bucket) present.add(r.category_bucket);
  }
  _categoriesCache = order.filter(b => present.has(b));
  return _categoriesCache;
}

// =============================================================================
// GROWW-CANONICAL EQUITY CATEGORIES
//
// Built 2026-05-03 after user reported "my mum wants to see Oil and Gas
// on /stocks but there are just random categories." Our raw NSE-derived
// sector strings include 30 fragmentary buckets (Energy, NBFC, Services,
// Other, Conglomerate, Internet, Fintech, Exchange, etc.) that no
// Indian retail investor recognises by those names. Groww + Zerodha +
// 5paisa all use a smaller, recognisable set aligned with the NSE
// Sectoral Indices nomenclature: Banking, Oil & Gas, IT, Pharma, FMCG,
// Auto, Power, Realty, etc.
//
// This map re-bins each raw sector onto a Groww-aligned canonical
// category. Conflict policy per the user's instruction: Groww wins.
// "Energy" in our raw data is overwhelmingly upstream/midstream
// petroleum (Reliance, ONGC, BPCL, IOC, GAIL) so it maps to "Oil &
// Gas" — Power gets its own bucket since NSE separates them too.
//
// The pill list shown to users is just the values present after
// mapping (unique + count > 0), ordered by getCanonicalCategoryOrder
// below. Any future raw sector that doesn't appear in the map falls
// through to "Other" via getCanonicalCategory's default branch.
const GROWW_CATEGORY_MAP = {
  "Auto":          "Auto",
  "Aviation":      "Aviation",
  "Banking":       "Banking",
  "Cement":        "Cement",
  "Chemicals":     "Chemicals",
  "Conglomerate":  "Conglomerate",
  "Construction":  "Construction",
  "Consumer":      "Consumer Durables",
  "Consumer Elec": "Consumer Durables",
  "Energy":        "Oil & Gas",
  "Exchange":      "Financial Services",
  "Fintech":       "NBFC",
  "FMCG":          "FMCG",
  "Food":          "FMCG",
  "Healthcare":    "Healthcare",
  "Infrastructure":"Infrastructure",
  "Insurance":     "Insurance",
  "Internet":      "Retail",
  "IT Services":   "IT",
  "Jewellery":     "Jewellery",
  "Metals":        "Metals",
  "NBFC":          "NBFC",
  "Other":         "Other",
  "Pharma":        "Pharma",
  "Power":         "Power",
  "Real Estate":   "Real Estate",
  "Retail":        "Retail",
  "Services":      "Services",
  "Telecom":       "Telecom",
  "Textiles":      "Textiles",
};

// Display order for the pill row. Alphabetical (A–Z) so users can
// scan-and-find by name; "Other" pinned to the end since it's a
// catch-all bucket users almost never want first. Any canonical not
// in this list still appears, sorted alphabetically after the named
// ones (defensive against future map additions). Hotfix64a — was
// recognisability-ordered before, but the user wanted Groww-style
// scanability.
const CANONICAL_CATEGORY_ORDER = [
  "Auto",
  "Aviation",
  "Banking",
  "Cement",
  "Chemicals",
  "Conglomerate",
  "Construction",
  "Consumer Durables",
  "Financial Services",
  "FMCG",
  "Healthcare",
  "Infrastructure",
  "Insurance",
  "IT",
  "Jewellery",
  "Metals",
  "NBFC",
  "Oil & Gas",
  "Pharma",
  "Power",
  "Real Estate",
  "Retail",
  "Services",
  "Telecom",
  "Textiles",
  "Other",
];

// Per-symbol Groww-canonical overrides — applied AFTER the raw-sector
// table lookup. Each entry forces a stock into the named canonical
// category regardless of what build-universe.mjs assigned, so we can
// patch individual mis-classifications without re-running the data
// build (those rebuilds blow away inline edits to universeFull.json).
//
// Hotfix64c — built 2026-05-03 from a 5-agent triangulation of Groww +
// Dhan + Trendlyne + Nifty Oil & Gas index. User's mum saw 44 on Groww
// vs our 37; the gap was caused by:
//   (a) inferFromName regex in scripts/build-universe.mjs routes any
//       company with "Energy" in the name to Power (Selan/Prabha/IRM/
//       Asian Energy Services), and
//   (b) NSE classifies Linde / PCBL / Panama Petrochem as Chemicals,
//       BHARATCOAL as Metals, SOTL as IT (the "Technologies" suffix
//       trips the IT regex), DEEPINDS as Infrastructure, etc.
// We move 13 genuine O&G stocks INTO Oil & Gas and move 7 false-
// positives (Megastar Foods etc. — caught by name regex on "oil"/
// "energy") OUT to their correct canonicals. Net: 37 → 43-44, exactly
// matching Groww. Add to this map for future single-stock fixes.
const SYMBOL_CANONICAL_OVERRIDES = {
  // ── Move INTO Oil & Gas (13 stocks Groww classifies as O&G) ───────
  ANTELOPUS:  "Oil & Gas",   // build → Power (name match /energy/)
  PRABHA:     "Oil & Gas",   // build → Power (name match /energy/)
  IRMENERGY:  "Oil & Gas",   // build → Power (name match /energy/)
  ASIANENE:   "Oil & Gas",   // build → Power (name match /energy/)
  BHARATCOAL: "Oil & Gas",   // build → Metals (NSE: Metals & Mining)
  DEEPINDS:   "Oil & Gas",   // build → Infrastructure (drilling svc)
  SOTL:       "Oil & Gas",   // build → IT Services (name "Technologies")
  VEEDOL:     "Oil & Gas",   // build → Other (Tide Water Oil)
  PANAMAPET:  "Oil & Gas",   // build → Chemicals (white oil maker)
  DOLPHIN:    "Oil & Gas",   // build → Conglomerate (offshore rigs)
  GNRL:       "Oil & Gas",   // build → Other (Gujarat Natural Resources)
  GANESHBE:   "Oil & Gas",   // build → Other (bulk liquid storage)
  KOTYARK:    "Oil & Gas",   // build → Infrastructure (biodiesel)
  LINDEINDIA: "Oil & Gas",   // build → Chemicals (industrial gases)
  REFEX:      "Oil & Gas",   // build → Chemicals (refrigerant/coal)
  GOACARBON:  "Oil & Gas",   // build → Other (calcined pet coke)
  GOCLCORP:   "Oil & Gas",   // build → Other (Gulf Oil parent)
  PCBL:       "Oil & Gas",   // build → Chemicals (carbon black)
  STALLION:   "Oil & Gas",   // build → Chemicals (Groww: Industrial Gases & Fuels)

  // ── Move OUT of Oil & Gas (false positives caught by name regex) ──
  MEGASTAR:   "FMCG",        // Megastar Foods — snack food, not petroleum
  GOKUL:      "FMCG",        // Gokul Refoils & Solvent — edible oils
  ROML:       "FMCG",        // Raj Oil Mills — edible cooking oil
  GODAVARIB:  "Chemicals",   // Godavari Biorefineries — sugar/ethanol
  KIOCL:      "Metals",      // KIOCL — iron ore pellets, not petroleum
  SANDUMA:    "Metals",      // Sandur Manganese & Iron Ores — mining
  SOUTHWEST:  "Services",    // South West Pinnacle Exploration — mineral, not O&G

  // =========================================================================
  // HOTFIX67c (2026-05-03) — mass cleanup from 5-agent brute-force pass.
  // User: "btw there's only one aviation sector in stocksaathi (INDIGO) ...
  //        brute force for all other sectors, no limits". 446
  //        verified-in-universe overrides covering Aviation
  //        (4), Financial Services (45), IT (16), Telecom (5+cables→Power
  //        moved to Power section), Pharma (21), Healthcare (16), FMCG (38),
  //        Consumer Durables (18), Auto (48), Power (37), Metals (24),
  //        Real Estate (17), Cement (13), Chemicals (48), Textiles (31),
  //        Construction (22), Infrastructure (13), Jewellery (5).
  // Cross-agent conflicts resolved per Groww-aligned classification (e.g.
  // POLYCAB/KEI/etc. → Power since most are electrical wires; specific
  // telecom-only cables → Telecom).
  // =========================================================================

  // ── Aviation expansion (was: only INDIGO) ──────────────────────────
  GLOBALVECT: "Aviation",         // Global Vectra Helicorp — helicopter charter
  HAL:        "Aviation",         // Hindustan Aeronautics — defense aerospace
  GMRAIRPORT: "Aviation",         // GMR Airports — Delhi/Hyderabad airports
  UNIMECH:    "Aviation",         // Unimech Aerospace — aero-engine tooling

  // ── Financial Services (AMCs, brokers, ratings, holdings) ──────────
  HDFCAMC:      "Financial Services",   // HDFC Asset Management
  "NAM-INDIA":  "Financial Services",   // Nippon Life India AMC
  ABSLAMC:      "Financial Services",   // Aditya Birla Sun Life AMC
  UTIAMC:       "Financial Services",   // UTI AMC
  ANGELONE:     "Financial Services",   // Angel One — discount broker
  MOTILALOFS:   "Financial Services",   // Motilal Oswal Financial Services
  NUVAMA:       "Financial Services",   // Nuvama Wealth (ex-Edelweiss Wealth)
  IIFLCAPS:     "Financial Services",   // IIFL Capital Services (broker)
  "360ONE":     "Financial Services",   // 360 ONE WAM (ex-IIFL Wealth)
  "5PAISA":     "Financial Services",   // 5Paisa Capital — discount broker
  GEOJITFSL:    "Financial Services",   // Geojit Financial Services
  SHAREINDIA:   "Financial Services",   // Share India Securities
  MONARCH:      "Financial Services",   // Monarch Networth Capital
  CHOICEIN:     "Financial Services",   // Choice International
  PRUDENT:      "Financial Services",   // Prudent Corporate Advisory
  RELIGARE:     "Financial Services",   // Religare Enterprises
  EDELWEISS:    "Financial Services",   // Edelweiss Financial Services
  JMFINANCIL:   "Financial Services",   // JM Financial
  CRISIL:       "Financial Services",   // CRISIL — credit rating
  ICRA:         "Financial Services",   // ICRA — credit rating
  CARERATING:   "Financial Services",   // CARE Ratings
  CAMS:         "Financial Services",   // Computer Age Mgmt Services (RTA)
  KFINTECH:     "Financial Services",   // KFin Technologies (RTA)
  PAYTM:        "Financial Services",   // One 97 Communications
  POLICYBZR:    "Financial Services",   // PB Fintech (Policybazaar)
  SBICARD:      "Financial Services",   // SBI Cards
  BAJAJFINSV:   "Financial Services",   // Bajaj Finserv (holding)
  ABCAPITAL:    "Financial Services",   // Aditya Birla Capital (holding)
  CHOLAHLDNG:   "Financial Services",   // Cholamandalam Financial Holdings
  MFSL:         "Financial Services",   // Max Financial Services (Max Life parent)
  BAJAJHLDNG:   "Financial Services",   // Bajaj Holdings & Investment
  TATAINVEST:   "Financial Services",   // Tata Investment Corp
  MAHSCOOTER:   "Financial Services",   // Maharashtra Scooters (Bajaj invest holding)
  BFINVEST:     "Financial Services",   // BF Investment (Bharat Forge holding)
  JSWHL:        "Financial Services",   // JSW Holdings
  KAMAHOLD:     "Financial Services",   // Kama Holdings (SRF parent)
  PILANIINVS:   "Financial Services",   // Pilani Investment (Birla holding)
  TVSHLTD:      "Financial Services",   // TVS Holdings
  SUMMITSEC:    "Financial Services",   // Summit Securities (RPG investment)
  BENGALASM:    "Financial Services",   // Bengal & Assam (CK Birla holding)
  NIACL:        "Insurance",            // New India Assurance (was NBFC — actually insurer)
  INDBANK:      "Financial Services",   // Indbank Merchant Banking (NOT a bank)
  CRAMC:        "Financial Services",   // Canara Robeco AMC

  // ── IT (mistagged as Other / Internet / Auto / Services) ───────────
  NAUKRI:     "IT",         // Info Edge — Naukri/Zomato parent
  FSL:        "IT",         // Firstsource Solutions — BPO/ITeS
  ECLERX:     "IT",         // eClerx Services — analytics BPO
  CMSINFO:    "IT",         // CMS Info Systems — IT-managed services
  MATRIMONY:  "IT",         // Matrimony.com — internet portal
  VAKRANGEE:  "IT",         // Vakrangee — IT-enabled e-gov
  EBGNG:      "IT",         // GNG Electronics — refurbished IT hardware
  RPTECH:     "IT",         // Rashi Peripherals — IT distribution
  DLINKINDIA: "IT",         // D-Link India — networking hardware
  NELCO:      "IT",         // NELCO — VSAT/satcom IT hardware
  CONTROLPR:  "IT",         // Control Print — coding/marking IT hardware
  SAKSOFT:    "IT",         // Saksoft — IT services
  SUBEXLTD:   "IT",         // Subex — telecom analytics software
  KSOLVES:    "IT",         // Ksolves India — IT services
  NIITLTD:    "IT",         // NIIT — IT training/edtech
  TVSELECT:   "IT",         // TVS Electronics — POS/IT peripherals (was Auto)

  // ── Telecom (broadband cable distributors + telecom-only cables) ───
  RCOM:       "Telecom",    // Reliance Communications (CIRP)
  ONMOBILE:   "Telecom",    // OnMobile Global — telecom VAS
  SUYOG:      "Telecom",    // Suyog Telematics — telecom tower infra
  VINDHYATEL: "Telecom",    // Vindhya Telelinks — telecom cables
  HATHWAY:    "Telecom",    // Hathway Cable & Datacom — broadband
  GTPL:       "Telecom",    // GTPL Hathway — cable MSO
  DEN:        "Telecom",    // Den Networks — cable MSO
  SITINET:    "Telecom",    // Siti Networks — cable MSO
  ORTEL:      "Telecom",    // Ortel Communications — cable broadband

  // ── Power (cables, transformers, OEMs, renewables) ────────────────
  POLYCAB:    "Power",      // Polycab — wires/cables/FMEG (mostly electrical)
  KEI:        "Power",      // KEI Industries — wires/cables/EPC
  RRKABEL:    "Power",      // R R Kabel — wires & cables
  FINCABLES:  "Power",      // Finolex Cables — power/control cables
  UNIVCABLES: "Power",      // Universal Cables — power cables (Birla group)
  PARACABLES: "Power",      // Paramount Communications — power/telecom cables
  BIRLACABLE: "Power",      // Birla Cable — power/optical cables
  DYCL:       "Power",      // Dynamic Cables — power cables
  PRECWIRE:   "Power",      // Precision Wires — winding wires
  SUZLON:     "Power",      // Suzlon Energy — wind turbines
  INOXWIND:   "Power",      // Inox Wind — wind turbines
  INOXGREEN:  "Power",      // Inox Green — wind O&M services
  BHEL:       "Power",      // Bharat Heavy Electricals
  SIEMENS:    "Power",      // Siemens India — power/automation
  ABB:        "Power",      // ABB India — electrification + motion
  ENRIN:      "Power",      // Siemens Energy India — power eq spinoff
  THERMAX:    "Power",      // Thermax — boilers/captive power
  TDPOWERSYS: "Power",      // TD Power Systems — generators
  TRITURBINE: "Power",      // Triveni Turbine — steam turbines
  VOLTAMP:    "Power",      // Voltamp Transformers
  TARIL:      "Power",      // Transformers And Rectifiers India
  TARAPUR:    "Power",      // Tarapur Transformers
  INDOTECH:   "Power",      // Indo Tech Transformers
  ATLANTAELE: "Power",      // Atlanta Electricals — transformers
  CGPOWER:    "Power",      // CG Power — transformers/motors
  SCHNEIDER:  "Power",      // Schneider Electric Infra — switchgear
  POWERINDIA: "Power",      // Hitachi Energy India — grid automation
  APARINDS:   "Power",      // Apar Industries — transmission conductors
  SKIPPER:    "Power",      // Skipper — transmission towers
  RMC:        "Power",      // RMC Switchgears
  VETO:       "Power",      // Veto Switchgears And Cables
  QPOWER:     "Power",      // Quality Power Electrical Equipments
  DIACABS:    "Power",      // Diamond Power Infrastructure — cables/conductors
  BORORENEW:  "Power",      // Borosil Renewables — solar glass
  EMMVEE:     "Power",      // Emmvee Photovoltaic — solar
  SAATVIKGL:  "Power",      // Saatvik Green Energy — solar modules
  UTLSOLAR:   "Power",      // Fujiyama Power — solar/inverters
  VIKRAMSOLR: "Power",      // Vikram Solar — modules
  WAAREERTL:  "Power",      // Waaree Renewable Technologies
  WEBELSOLAR: "Power",      // Websol Energy — solar cells
  SWSOLAR:    "Power",      // Sterling and Wilson Renewable — solar EPC
  TECHNOE:    "Power",      // Techno Electric — power T&D EPC
  POWERMECH:  "Power",      // Power Mech Projects — power EPC + O&M
  ELECON:     "Power",      // Elecon Engineering — gears for power plants
  HBLENGINE:  "Power",      // HBL Engineering — industrial batteries
  URJA:       "Power",      // Urja Global — solar/power

  // ── Pharma (drugs/APIs) ────────────────────────────────────────────
  BLUEJET:    "Pharma",     // Blue Jet Healthcare — APIs/intermediates
  SHILPAMED:  "Pharma",     // Shilpa Medicare — oncology APIs
  BAJAJHCARE: "Pharma",     // Bajaj Healthcare — APIs
  SAKAR:      "Pharma",     // Sakar Healthcare — formulations
  AHCL:       "Pharma",     // Anlon Healthcare — pharma intermediates
  AMANTA:     "Pharma",     // Amanta Healthcare — sterile injectables
  TTKHLTCARE: "Pharma",     // TTK Healthcare — OTC pharma
  SANOFICONR: "Pharma",     // Sanofi Consumer Healthcare
  HIKAL:      "Pharma",     // Hikal — APIs + crop protection
  LASA:       "Pharma",     // Lasa Supergenerics — vet APIs
  DCAL:       "Pharma",     // Dishman Carbogen Amcis — CRAMS
  ALEMBICLTD: "Pharma",     // Alembic Limited — pharma holding
  NECLIFE:    "Pharma",     // Nectar Lifesciences — APIs + formulations
  VIVIMEDLAB: "Pharma",     // Vivimed Labs — APIs + specialty
  LYKALABS:   "Pharma",     // Lyka Labs — sterile injectables
  WANBURY:    "Pharma",     // Wanbury — APIs + formulations
  SHIVALIK:   "Pharma",     // Shivalik Rasayan — pharma intermediates
  GUFICBIO:   "Pharma",     // Gufic Biosciences — sterile injectables
  GUJTHEM:    "Pharma",     // Gujarat Themis Biosyn — pharma fermentation
  THEMISMED:  "Pharma",     // Themis Medicare — formulations
  "3BBLACKBIO":"Pharma",    // 3B Blackbio Dx — molecular diagnostics

  // ── Healthcare (hospitals + diagnostics + medical equipment) ──────
  MEDIASSIST: "Healthcare", // Medi Assist Healthcare — TPA services
  MEDANTA:    "Healthcare", // Global Health = Medanta hospitals
  PARKHOSPS:  "Healthcare", // Park Medi World — multi-specialty hospitals
  SHALBY:     "Healthcare", // Shalby — orthopaedic hospital chain
  ARTEMISMED: "Healthcare", // Artemis Medicare — Gurgaon hospital
  GAUDIUMIVF: "Healthcare", // Gaudium IVF — fertility clinics
  AGARWALEYE: "Healthcare", // Dr. Agarwal's Health Care — eye hospitals
  MEDPLUS:    "Healthcare", // MedPlus — pharmacy retail
  ENTERO:     "Healthcare", // Entero Healthcare — pharma distribution
  LALPATHLAB: "Healthcare", // Dr Lal PathLabs — diagnostics
  THYROCARE:  "Healthcare", // Thyrocare — diagnostics
  VIMTALABS:  "Healthcare", // Vimta Labs — clinical research
  LENSKART:   "Healthcare", // Lenskart — eyewear (Groww: medical equipment)
  LAXMIDENTL: "Healthcare", // Laxmi Dental — dental implants
  TARSONS:    "Healthcare", // Tarsons Products — labware
  SYNGENE:    "Healthcare", // Syngene — CRO for pharma

  // ── FMCG (food/snack/beverage/QSR/stationery/personal care) ────────
  GLOBUSSPR:  "FMCG",       // Globus Spirits — distillery
  GMBREW:     "FMCG",       // GM Breweries — distillery
  ASALCBR:    "FMCG",       // Associated Alcohols & Breweries
  RKDL:       "FMCG",       // Ravi Kumar Distilleries
  JUBLFOOD:   "FMCG",       // Jubilant Foodworks — Domino's India
  DEVYANI:    "FMCG",       // Devyani International — KFC/Pizza Hut
  WESTLIFE:   "FMCG",       // Westlife Foodworld — McDonald's W&S
  SAPPHIRE:   "FMCG",       // Sapphire Foods — KFC/Pizza Hut
  RBA:        "FMCG",       // Restaurant Brands Asia — Burger King
  HATSUN:     "FMCG",       // Hatsun Agro — dairy
  DODLA:      "FMCG",       // Dodla Dairy
  PARAGMILK:  "FMCG",       // Parag Milk Foods — Gowardhan
  KWIL:       "FMCG",       // Kwality Wall's — ice cream
  VADILALIND: "FMCG",       // Vadilal Industries — ice cream
  GRMOVER:    "FMCG",       // GRM Overseas — basmati rice
  DIAMONDYD:  "FMCG",       // Prataap Snacks — Yellow Diamond
  HMAAGRO:    "FMCG",       // HMA Agro — frozen meat
  APEX:       "FMCG",       // Apex Frozen Foods — shrimp
  TASTYBITE:  "FMCG",       // Tasty Bite Eatables — ready meals
  VENKEYS:    "FMCG",       // Venky's — poultry
  HAWKINCOOK: "FMCG",       // Hawkins Cookers — kitchen
  FOODSIN:    "FMCG",       // Foods & Inns — fruit/veg processing
  HNDFDS:     "FMCG",       // Hindustan Foods — contract FMCG
  SUNDROP:    "FMCG",       // Sundrop Brands — edible oils
  GOLDENTOBC: "FMCG",       // Golden Tobacco — cigarettes
  KOKUYOCMLN: "FMCG",       // Kokuyo Camlin — stationery
  LINC:       "FMCG",       // Linc — pens/stationery
  FLAIR:      "FMCG",       // Flair Writing — pens/stationery
  BAJAJHIND:  "FMCG",       // Bajaj Hindusthan — sugar
  DHAMPURSUG: "FMCG",       // Dhampur Sugar Mills
  DALMIASUG:  "FMCG",       // Dalmia Bharat Sugar
  VSTIND:     "FMCG",       // VST Industries — cigarettes
  MCLEODRUSS: "FMCG",       // McLeod Russel — tea
  JAYSREETEA: "FMCG",       // Jayshree Tea
  BAJAJCON:   "FMCG",       // Bajaj Consumer Care — Almond Drops
  EVEREADY:   "FMCG",       // Eveready — batteries
  NIPPOBATRY: "FMCG",       // Indo-National (Nippo batteries)
  SULA:       "FMCG",       // Sula Vineyards — wine

  // ── Consumer Durables (appliances, ceramics, sanitaryware, watches) ─
  TTKPRESTIG: "Consumer Durables",   // TTK Prestige — pressure cookers
  BUTTERFLY:  "Consumer Durables",   // Butterfly Gandhimathi — kitchen
  SYMPHONY:   "Consumer Durables",   // Symphony — air coolers
  ORIENTELEC: "Consumer Durables",   // Orient Electric — fans/lighting
  TIMEX:      "Consumer Durables",   // Timex Group India — watches
  SOMANYCERA: "Consumer Durables",   // Somany Ceramics — tiles
  HINDWAREAP: "Consumer Durables",   // Hindware — bath fittings
  ASIANTILES: "Consumer Durables",   // Asian Granito — vitrified tiles
  ICEMAKE:    "Consumer Durables",   // Ice Make Refrigeration
  LAOPALA:    "Consumer Durables",   // La Opala RG — opal glassware
  BOROLTD:    "Consumer Durables",   // Borosil Limited — glassware
  HITECHCORP: "Consumer Durables",   // Hitech Corporation — packaging
  NILKAMAL:   "Consumer Durables",   // Nilkamal — plastic furniture
  MIRCELECTR: "Consumer Durables",   // MIRC Electronics — Onida
  BPL:        "Consumer Durables",   // BPL — appliances
  SINGERIND:  "Consumer Durables",   // Singer India — sewing/appliances
  CARYSIL:    "Consumer Durables",   // Carysil — quartz sinks
  EPACK:      "Consumer Durables",   // EPACK Durable — air conditioners

  // ── Auto (OEMs, ancillaries, tyres, bearings, forgings) ───────────
  ASHOKLEY:   "Auto",       // Ashok Leyland — CV/truck OEM
  TMCV:       "Auto",       // Tata Motors CV (post-demerger)
  ESCORTS:    "Auto",       // Escorts Kubota — tractors
  SWARAJENG:  "Auto",       // Swaraj Engines — tractor engines
  VSTTILLERS: "Auto",       // VST Tillers Tractors
  GREAVESCOT: "Auto",       // Greaves Cotton — engines + 3W
  HMT:        "Auto",       // HMT Limited — tractors heritage
  ATLASCYCLE: "Auto",       // Atlas Cycles — bicycles
  KIRLOSENG:  "Auto",       // Kirloskar Oil Engines — diesel/auto
  SUNDRMFAST: "Auto",       // Sundram Fasteners — auto fasteners
  SUPRAJIT:   "Auto",       // Suprajit Engineering — control cables
  SUBROS:     "Auto",       // Subros — auto AC
  TIMKEN:     "Auto",       // Timken India — bearings
  MMFL:       "Auto",       // MM Forgings — CV components
  HARSHA:     "Auto",       // Harsha Engineers — bearing cages
  PAVNAIND:   "Auto",       // Pavna Industries — locksets
  HITECHGEAR: "Auto",       // The Hi-Tech Gears
  BHARATGEAR: "Auto",       // Bharat Gears
  BHARATSE:   "Auto",       // Bharat Seats — Maruti supplier
  LUMAXIND:   "Auto",       // Lumax Industries — auto lighting
  RAJRATAN:   "Auto",       // Rajratan Global Wire — bead wire
  ZFSTEERING: "Auto",       // ZF Steering Gear
  GNA:        "Auto",       // GNA Axles
  UNIPARTS:   "Auto",       // Uniparts India — precision auto
  WHEELS:     "Auto",       // Wheels India — TVS-group wheels
  SANDHAR:    "Auto",       // Sandhar Technologies — locks/mirrors
  CARRARO:    "Auto",       // Carraro India — drivetrain
  FMGOETZE:   "Auto",       // Federal-Mogul Goetze — pistons
  JTEKTINDIA: "Auto",       // Jtekt India — steering systems
  GOODYEAR:   "Auto",       // Goodyear India — tyres
  MUNJALSHOW: "Auto",       // Munjal Showa — shock absorbers
  ROLEXRINGS: "Auto",       // Rolex Rings — forged bearing rings
  NRBBEARING: "Auto",       // NRB Bearing — needle bearings
  MENONBE:    "Auto",       // Menon Bearings — bushings
  SHANTIGEAR: "Auto",       // Shanthi Gears — Murugappa-group gears
  SJS:        "Auto",       // SJS Enterprises — auto aesthetics
  LGBBROSLTD: "Auto",       // LG Balakrishnan — Rolon chains
  PRECAM:     "Auto",       // Precision Camshafts
  BALUFORGE:  "Auto",       // Balu Forge — crankshafts/forgings
  HAPPYFORGE: "Auto",       // Happy Forgings — heavy CV forgings
  RML:        "Auto",       // Rane Madras — steering / auto components
  UCAL:       "Auto",       // UCAL — fuel injection
  STERTOOLS:  "Auto",       // Sterling Tools — auto fasteners
  SINTERCOM:  "Auto",       // Sintercom India — sintered auto parts
  HINDCOMPOS: "Auto",       // Hindustan Composites — clutch/brake friction
  KROSS:      "Auto",       // Kross — trailer axles/forgings
  MAYURUNIQ:  "Auto",       // Mayur Uniquoters — synthetic leather
  LANDMARK:   "Auto",       // Landmark Cars — premium auto dealer

  // ── Metals (pipes, alloys, mining, ferro alloys) ──────────────────
  APLAPOLLO:  "Metals",     // APL Apollo Tubes — #1 steel tubes
  WELCORP:    "Metals",     // Welspun Corp — line pipes
  MANINDS:    "Metals",     // Man Industries — large-dia pipes
  MAHSEAMLES: "Metals",     // Maharashtra Seamless — seamless pipes
  JINDALSAW:  "Metals",     // Jindal SAW — pipes/tubes
  JTLIND:     "Metals",     // JTL Industries — ERW steel tubes
  ELECTCAST:  "Metals",     // Electrosteel Castings — DI pipes
  SHYAMMETL:  "Metals",     // Shyam Metalics — sponge iron/billets
  MIDHANI:    "Metals",     // Mishra Dhatu Nigam — special metals
  MAITHANALL: "Metals",     // Maithan Alloys — ferro alloys
  SHAHALLOYS: "Metals",     // Shah Alloys — stainless steel
  GPIL:       "Metals",     // Godawari Power & Ispat — sponge iron
  KIRLFER:    "Metals",     // Kirloskar Ferrous — pig iron
  ALICON:     "Metals",     // Alicon Castalloy — aluminium die-castings
  GRAPHITE:   "Metals",     // Graphite India — graphite electrodes
  BANSALWIRE: "Metals",     // Bansal Wire — steel wires
  BHARATWIRE: "Metals",     // Bharat Wire Ropes
  RAMRAT:     "Metals",     // Ram Ratna Wires — copper winding wire
  MUKANDLTD:  "Metals",     // Mukand — alloy steel
  TIRUPATIFL: "Metals",     // Tirupati Forge
  HEXATRADEX: "Metals",     // Hexa Tradex — Jindal stainless trading
  NELCAST:    "Metals",     // Nelcast — iron castings
  ASHOKAMET:  "Metals",     // Ashoka Metcast — castings
  MODISONLTD: "Metals",     // Modison — copper contacts

  // ── Real Estate (developers + commercial workspaces) ──────────────
  ABREL:      "Real Estate",   // Aditya Birla Real Estate
  HUBTOWN:    "Real Estate",   // Hubtown — Mumbai realty
  ARVSMART:   "Real Estate",   // Arvind SmartSpaces — Ahmedabad
  OMAXE:      "Real Estate",   // Omaxe — NCR builder
  ARIHANTSUP: "Real Estate",   // Arihant Superstructures
  PURVA:      "Real Estate",   // Puravankara
  RUSTOMJEE:  "Real Estate",   // Keystone Realtors (Rustomjee)
  KALPATARU:  "Real Estate",   // Kalpataru — Mumbai realty
  SUNTECK:    "Real Estate",   // Sunteck Realty
  TARC:       "Real Estate",   // TARC (ex-Anant Raj demerger)
  PENINLAND:  "Real Estate",   // Peninsula Land
  NIRLON:     "Real Estate",   // Nirlon — Mumbai office park
  HLVLTD:     "Real Estate",   // HLV (ex-Leela hospitality)
  GEECEE:     "Real Estate",   // GeeCee Ventures
  AGIIL:      "Real Estate",   // AGI Infra — Jalandhar realty
  EFCIL:      "Real Estate",   // EFC — flexible workspaces
  PVP:        "Real Estate",   // PVP Ventures — Chennai realty

  // ── Cement & Construction Materials (incl. tiles, sanitaryware) ────
  KCP:         "Cement",   // KCP — Andhra cement
  EUROBOND:    "Cement",   // Euro Panel Products — sandwich panels
  HARDWYN:     "Cement",   // Hardwyn India — architectural hardware
  POKARNA:     "Cement",   // Pokarna — granite + Quantra quartz
  MADHAV:      "Cement",   // Madhav Marbles & Granites
  BEARDSELL:   "Cement",   // Beardsell — EPS thermal panels
  EXXARO:      "Cement",   // Exxaro Tiles
  NITCO:       "Cement",   // Nitco — tiles
  REGENCERAM:  "Cement",   // Regency Ceramics
  MURUDCERA:   "Cement",   // Murudeshwar Ceramics
  LEXUS:       "Cement",   // Lexus Granito
  ORIENTALTL:  "Cement",   // Oriental Trimex — marble/granite
  ORIENTBELL:  "Cement",   // Orient Bell — tiles

  // ── Chemicals (specialty + bulk + petrochem + dyes/pigments + agrochem) ──
  VINATIORGA:  "Chemicals",  // Vinati Organics — ATBS specialty
  VALIANTORG:  "Chemicals",  // Valiant Organics
  MOL:         "Chemicals",  // Meghmani Organics
  CHEMPLASTS:  "Chemicals",  // Chemplast Sanmar — PVC
  EPIGRAL:     "Chemicals",  // Epigral (ex-Meghmani Finechem)
  BHARATRAS:   "Chemicals",  // Bharat Rasayan — agrochem
  NOCIL:       "Chemicals",  // NOCIL — rubber chemicals
  SADHNANIQ:   "Chemicals",  // Sadhana Nitrochem
  INDOAMIN:    "Chemicals",  // Indo Amines — specialty amines
  BLACKROSE:   "Chemicals",  // Black Rose Industries
  PAUSHAKLTD:  "Chemicals",  // Paushak — phosgene specialty
  TRANSPEK:    "Chemicals",  // Transpek Industry — acid chlorides
  DAICHI:      "Chemicals",  // Dai-Ichi Karkaria — surfactants
  GULPOLY:     "Chemicals",  // Gulshan Polyols — sorbitol
  NGLFINE:     "Chemicals",  // NGL Fine-Chem
  CAMLINFINE:  "Chemicals",  // Camlin Fine Sciences — antioxidants
  MANORG:      "Chemicals",  // Mangalam Organics — terpene
  DCW:         "Chemicals",  // DCW — caustic soda, PVC
  TNPETRO:     "Chemicals",  // Tamilnadu Petroproducts — LAB
  ULTRAMAR:    "Chemicals",  // Ultramarine & Pigments
  PARASPETRO:  "Chemicals",  // Paras Petrofils — specialty petro chem
  AKSHARCHEM:  "Chemicals",  // AksharChem — vinyl sulphone
  PILITA:      "Chemicals",  // PIL Italica Lifestyle — pigments+plastics
  ASAHISONG:   "Chemicals",  // Asahi Songwon Colors
  DICIND:      "Chemicals",  // DIC India — printing inks
  POLYPLEX:    "Chemicals",  // Polyplex — PET films
  DYNPRO:      "Chemicals",  // Dynemic Products — food colors
  PASUPTAC:    "Chemicals",  // Pasupati Acrylon — acrylic fibre
  VARDMNPOLY:  "Chemicals",  // Vardhman Acrylics
  OCCLLTD:     "Chemicals",  // OCCL — Oriental Carbon
  PODDARMENT:  "Chemicals",  // Poddar Pigments — masterbatches
  KANCHI:      "Chemicals",  // Kanchi Karpooram — camphor
  RAMAPHO:     "Chemicals",  // Rama Phosphates — fertilizers
  KRISHANA:    "Chemicals",  // Krishana Phoschem
  GRAUWEIL:    "Chemicals",  // Grauer & Weil — surface finishing
  REGAAL:      "Chemicals",  // Regaal Resources — maize starch
  SANSTAR:     "Chemicals",  // Sanstar — maize starch
  VIDHIING:    "Chemicals",  // Vidhi Specialty Food Ingredients
  HALDER:      "Chemicals",  // Halder Venture — agri/chem
  FAIRCHEMOR:  "Chemicals",  // Fairchem Organics — oleochem
  ASTEC:       "Chemicals",  // Astec LifeSciences — agrochem
  AVTNPL:      "Chemicals",  // AVT Natural Products
  DBOL:        "Chemicals",  // Dhampur Bio Organics
  GSPCROP:     "Chemicals",  // GSP Crop Science
  DHARMAJ:     "Chemicals",  // Dharmaj Crop Guard — agrochem
  IGCL:        "Chemicals",  // Indogulf Cropsciences
  EMSLIMITED:  "Chemicals",  // EMS Limited — water/sewage chem + EPC
  SHK:         "Chemicals",  // S H Kelkar — fragrances
  RPEL:        "Chemicals",  // Raghav Productivity Enhancers — refractories

  // ── Textiles (apparel, fabric, footwear, yarn) ─────────────────────
  TRIDENT:    "Textiles",   // Trident — terry towels/yarn
  VTL:        "Textiles",   // Vardhman Textiles — yarn/fabric
  KPRMILL:    "Textiles",   // K.P.R. Mill — yarn + garments
  RUPA:       "Textiles",   // Rupa & Company — innerwear
  ARVIND:     "Textiles",   // Arvind — denim/woven
  PAGEIND:    "Textiles",   // Page Industries — Jockey
  GOCOLORS:   "Textiles",   // Go Fashion — Go Colors apparel
  METROBRAND: "Textiles",   // Metro Brands — footwear
  RAYMOND:    "Textiles",   // Raymond — fabric (post-demerger)
  RAYMONDLSL: "Textiles",   // Raymond Lifestyle — apparel/retail
  KKCL:       "Textiles",   // Kewal Kiran — Killer Jeans
  VIPCLOTHNG: "Textiles",   // VIP Clothing — innerwear
  LIBERTSHOE: "Textiles",   // Liberty Shoes — footwear
  MIRZAINT:   "Textiles",   // Mirza International — Red Tape footwear
  ZODIACLOTH: "Textiles",   // Zodiac Clothing — formal shirts
  GOKEX:      "Textiles",   // Gokaldas Exports — apparel exporter
  HIMATSEIDE: "Textiles",   // Himatsingka Seide — bedlinen
  BANSWRAS:   "Textiles",   // Banswara Syntex — yarn/fabric
  SANGAMIND:  "Textiles",   // Sangam — yarn/fabric
  ICIL:       "Textiles",   // Indo Count — bedlinen
  KITEX:      "Textiles",   // Kitex Garments — infant wear
  FILATEX:    "Textiles",   // Filatex India — polyester yarn
  RSWM:       "Textiles",   // RSWM (LNJ Bhilwara) — yarn
  BSL:        "Textiles",   // BSL Limited — suiting
  BOMDYEING:  "Textiles",   // Bombay Dyeing
  CENTENKA:   "Textiles",   // Century Enka — nylon yarn
  NITINSPIN:  "Textiles",   // Nitin Spinners
  PRECOT:     "Textiles",   // Precot — cotton yarn
  CHEVIOT:    "Textiles",   // Cheviot — jute
  LOVABLE:    "Textiles",   // Lovable Lingerie
  KHADIM:     "Textiles",   // Khadim India — footwear

  // ── Construction (capital goods + EPC) ────────────────────────────
  OMINFRAL:   "Construction",   // Om Infra — hydro mech EPC
  TARMAT:     "Construction",   // Tarmat — runway/road construction
  UNIVASTU:   "Construction",   // Univastu India
  CEIGALL:    "Construction",   // Ceigall India — road EPC
  SEPC:       "Construction",   // SEPC Limited — EPC
  USK:        "Construction",   // Udayshivakumar Infra — Karnataka EPC
  BLKASHYAP:  "Construction",   // B. L. Kashyap — civil
  SHANKARA:   "Construction",   // Shankara Building Products
  JYOTISTRUC: "Construction",   // Jyoti Structures — transmission EPC
  SPMLINFRA:  "Construction",   // SPML Infra — water EPC
  VPRPL:      "Construction",   // Vishnu Prakash R Punglia — water/road
  TRF:        "Construction",   // TRF — material handling
  TIL:        "Construction",   // TIL — material handling cranes
  WPIL:       "Construction",   // WPIL — pumps for water/EPC
  VESUVIUS:   "Construction",   // Vesuvius India — refractories
  IFGLEXPOR:  "Construction",   // IFGL Refractories
  LMW:        "Construction",   // LMW — textile machinery
  SALZERELEC: "Construction",   // Salzer Electronics — switchgear
  ELECTHERM:  "Construction",   // Electrotherm — induction furnaces
  CENTUM:     "Construction",   // Centum Electronics — defence/aero
  AVANTEL:    "Construction",   // Avantel — defence comms
  RISHABH:    "Construction",   // Rishabh Instruments — test/measure

  // ── Infrastructure (logistics + roads + waste + dredging) ─────────
  BRNL:       "Infrastructure", // Bharat Road Network — road BOT
  GAYAHWS:    "Infrastructure", // Gayatri Highways
  NOIDATOLL:  "Infrastructure", // Noida Toll Bridge — DND BOT
  NAVKARCORP: "Infrastructure", // Navkar Corp — CFS logistics
  GATEWAY:    "Infrastructure", // Gateway Distriparks
  TCI:        "Infrastructure", // Transport Corporation of India
  WCIL:       "Infrastructure", // Western Carriers India
  GLOTTIS:    "Infrastructure", // Glottis — freight forwarding
  ARSHIYA:    "Infrastructure", // Arshiya — FTWZ logistics
  AWHCL:      "Infrastructure", // Antony Waste Handling
  SIGNPOST:   "Infrastructure", // Signpost India — outdoor media infra
  SEAMECLTD:  "Infrastructure", // Seamec — offshore support vessels
  DREDGECORP: "Infrastructure", // Dredging Corporation of India

  // ── Industrial pipes (Infrastructure default per Groww) ───────────
  PRINCEPIPE: "Infrastructure", // Prince Pipes
  APOLLOPIPE: "Infrastructure", // Apollo Pipes
  HITECH:     "Infrastructure", // Hi-Tech Pipes
  INDIANHUME: "Infrastructure", // Indian Hume Pipe
  VENUSPIPES: "Infrastructure", // Venus Pipes & Tubes
  TIJARIA:    "Infrastructure", // Tijaria Polypipes
  TEXMOPIPES: "Infrastructure", // Texmo Pipes
  SCODATUBES: "Infrastructure", // Scoda Tubes
  GANDHITUBE: "Infrastructure", // Gandhi Special Tubes
  EKC:        "Infrastructure", // Everest Kanto Cylinder
  KRITI:      "Infrastructure", // Kriti Industries — PVC
  PPL:        "Infrastructure", // Prakash Pipes

  // ── Jewellery (Diamond, Gems & Jewellery per Groww) ────────────────
  TBZ:         "Jewellery",  // Tribhovandas Bhimji Zaveri
  SHANTIGOLD:  "Jewellery",  // Shanti Gold International
  SHRINGARMS:  "Jewellery",  // Shringar House of Mangalsutra
  DPABHUSHAN:  "Jewellery",  // D. P. Abhushan
  LGHL:        "Jewellery",  // Laxmi Goldorna House
};

/**
 * Map a raw instrument to its Groww-canonical category.
 * Returns "Other" for unknown sectors so we never lose a stock.
 * ETFs and MFs return null — they have their own filter rows.
 *
 * Per-symbol overrides win over the raw-sector lookup so we can patch
 * individual mis-classifications surgically. See SYMBOL_CANONICAL_OVERRIDES.
 */
export function getCanonicalCategory(inst) {
  if (!inst || inst.kind === "ETF" || inst.kind === "MF") return null;
  if (inst.symbol && SYMBOL_CANONICAL_OVERRIDES[inst.symbol]) {
    return SYMBOL_CANONICAL_OVERRIDES[inst.symbol];
  }
  const raw = inst.sector;
  if (!raw || raw === "Unknown") return "Other";
  return GROWW_CATEGORY_MAP[raw] || "Other";
}

/**
 * { categoryName: count } for every Groww-canonical bucket present in
 * the loaded equity universe. Sorted by CANONICAL_CATEGORY_ORDER, with
 * any unmapped extras appended alphabetically. Excludes empty buckets.
 * Used by stocks.js to render the pill row with counts.
 *
 * Returns [] before universeFull.json loads (pill row stays in
 * skeleton state). Re-evaluated on every call — counts are O(n) over
 * 2,364 stocks, sub-millisecond, no need to cache.
 */
export function getCanonicalCategoryCounts() {
  if (!_fullBySymbol) return [];
  const counts = {};
  for (const r of Object.values(_fullBySymbol)) {
    const c = getCanonicalCategory(r);
    if (!c) continue;
    counts[c] = (counts[c] || 0) + 1;
  }
  const present = Object.keys(counts);
  const ordered = [];
  for (const name of CANONICAL_CATEGORY_ORDER) {
    if (counts[name]) ordered.push({ name, count: counts[name] });
  }
  // Catch any canonical that ended up in counts but wasn't in the
  // declared order (defensive — shouldn't happen with the current map).
  for (const name of present.sort()) {
    if (!CANONICAL_CATEGORY_ORDER.includes(name) && counts[name]) {
      ordered.push({ name, count: counts[name] });
    }
  }
  return ordered;
}
