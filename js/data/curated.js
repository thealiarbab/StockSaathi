// =============================================================================
// CURATED — featured symbols + onboarding portfolios. NO HAND-TYPED DATA.
//
// User's hard rule: zero hand-typed values. Every numerical field (sector,
// marketCap, PE, PB, beta, divYield, risk, logo, price) comes from automated
// sources:
//   - Sector / industry / risk / cap_bucket: build-universe.mjs (NSE
//     classification + Nifty sectoral CSVs + name keyword regex + Yahoo
//     assetProfile via crumb)
//   - market_cap, PE, PB, beta, divYield, EPS: /api/fundamentals (Yahoo
//     crumb + Tickertape, cached in Supabase fundamentals_cache)
//   - Price / OHLC / 52W: /api/quote, /api/history (Yahoo v8/chart)
//   - Logo: algorithmic (first 3 chars of symbol)
//
// This file is now metadata-only — it only owns:
//   1. FEATURED_SYMBOLS — which tickers should appear at the top of the
//      Stocks tab on cold load (before market-cap sort kicks in)
//   2. ONBOARDING_PORTFOLIOS — UX choice for cautious / balanced / bold
//      starter packs
// =============================================================================

// Featured tickers — large/mid-cap stocks Indian users recognize. Used only
// for cold-load display ordering before sort/filter takes over. The actual
// sector/marketCap/PE/etc. for each comes from /api/fundamentals at runtime.
export const FEATURED_SYMBOLS = [
  // Mega caps (Nifty 50)
  "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "BHARTIARTL", "SBIN",
  "ITC", "LT", "HINDUNILVR", "AXISBANK", "KOTAKBANK", "BAJFINANCE", "HCLTECH",
  "MARUTI", "SUNPHARMA", "ASIANPAINT", "TITAN", "BAJAJFINSV", "NESTLEIND",
  "ULTRACEMCO", "WIPRO", "ONGC", "NTPC", "POWERGRID", "TATASTEEL", "JSWSTEEL",
  "HINDALCO", "COALINDIA", "M&M", "TMPV", "TMCV", "EICHERMOT", "BAJAJ-AUTO",
  "TECHM", "LTIM", "DRREDDY", "CIPLA", "DIVISLAB", "GRASIM", "ADANIENT",
  "ADANIPORTS", "HDFCLIFE", "SBILIFE", "BRITANNIA", "TATACONSUM", "INDUSINDBK",
  "HEROMOTOCO", "APOLLOHOSP", "TATAMOTORS",
  // Internet / fintech
  "ETERNAL", "PAYTM", "NYKAA", "POLICYBZR", "DMART",
  // High-volume mid-caps
  "TRENT", "VBL", "DLF", "PIDILITIND", "GODREJCP", "HAVELLS", "PERSISTENT",
  "CHOLAFIN", "MOTHERSON", "AMBUJACEM", "TVSMOTOR", "SIEMENS", "IRCTC",
  "BPCL", "IOC", "GAIL", "ADANIGREEN", "ADANIPOWER", "VEDL", "TATAPOWER",
  "INDIGO", "BANKBARODA", "PNB", "CANBK", "FEDERALBNK", "IDFCFIRSTB",
  "HDFCAMC", "SBICARD", "ICICIPRULI", "LICI", "BAJAJHLDNG",
  // PSU + infra
  "IRFC", "RECLTD", "PFC", "HINDPETRO", "POWERINDIA",
  // Pharma extra
  "AUROPHARMA", "LUPIN", "BIOCON", "TORNTPHARM", "ALKEM",
  // Cement extra
  "SHREECEM", "ACC",
  // Real estate
  "GODREJPROP", "LODHA", "OBEROIRLTY",
  // Healthcare
  "MAXHEALTH", "FORTIS",
  // FMCG / consumer extra
  "MARICO", "DABUR", "COLPAL", "UBL", "UNITDSPR", "BERGEPAINT", "PAGEIND",
  "JUBLFOOD", "VOLTAS", "WHIRLPOOL", "DIXON", "POLYCAB",
  // Telecom extra
  "TATACOMM",
];

// Featured mutual funds: real AMFI schemes, Direct plan, Growth option.
// The names here only cover the first paint, before mfFull.json loads; the
// AMFI catalogue then supplies the full record (NAV, category, AMC).
//
// These used to be ten hand-typed placeholders (MF_NIFTY50_INDEX, ...) with
// no NAV anywhere: they opened as pages and showed up in search, but could
// never be bought or valued. One user held one worth Rs 0. LEGACY_MF_ALIASES
// keeps old links working by mapping each to the real scheme.
export const FEATURED_MFS = [
  { symbol: "MF_120716", name: "UTI Nifty 50 Index Fund - Direct Plan - Growth", category: "Index", risk: "low", bench: "NIFTY 50" },
  { symbol: "MF_149803", name: "UTI BSE Sensex Index Fund - Direct Plan - Growth", category: "Index", risk: "low", bench: "SENSEX" },
  { symbol: "MF_120684", name: "ICICI Prudential Nifty Next 50 Index Fund - Direct Plan - Growth", category: "Index", risk: "med", bench: "NIFTY Next 50" },
  { symbol: "MF_122639", name: "Parag Parikh Flexi Cap Fund - Direct Plan - Growth", category: "Equity", risk: "med", bench: "NIFTY 500" },
  { symbol: "MF_118825", name: "Mirae Asset Large Cap Fund - Direct Plan - Growth", category: "Equity", risk: "med", bench: "NIFTY 100" },
  { symbol: "MF_125354", name: "Axis Small Cap Fund - Direct Plan - Growth", category: "Equity", risk: "high", bench: "NIFTY SmallCap 250" },
  { symbol: "MF_119598", name: "SBI Large Cap Fund - Direct Plan - Growth", category: "Equity", risk: "med", bench: "BSE 100" },
  { symbol: "MF_118968", name: "HDFC Balanced Advantage Fund - Direct Plan - Growth", category: "Hybrid", risk: "med", bench: "CRISIL Hybrid" },
  { symbol: "MF_120197", name: "ICICI Prudential Liquid Fund - Direct Plan - Growth", category: "Debt", risk: "low", bench: "CRISIL Liquid" },
  { symbol: "MF_118663", name: "Nippon India Gold Savings Fund - Direct Plan - Growth", category: "Gold", risk: "med", bench: "Domestic Gold" },
];
export const FEATURED_MF_CODES = FEATURED_MFS.map(m => m.symbol);

export const LEGACY_MF_ALIASES = {
  MF_NIFTY50_INDEX: "MF_120716",
  MF_SENSEX_INDEX: "MF_149803",
  MF_NIFTY_NEXT_50: "MF_120684",
  MF_PARAG_FLEXI: "MF_122639",
  MF_MIRAE_LARGE: "MF_118825",
  MF_AXIS_SMALL: "MF_125354",
  MF_SBI_BLUECHIP: "MF_119598",
  MF_HDFC_BALANCED: "MF_118968",
  MF_ICICI_LIQUID: "MF_120197",
  MF_NIPPON_GOLD: "MF_118663",
};

// Onboarding starter portfolios — UX choice (which symbols + how many units),
// not data. The actual price + market cap of each holding comes from
// /api/quote and /api/fundamentals at runtime.
export const ONBOARDING_PORTFOLIOS = {
  cautious: [
    { symbol: "MF_120716", qty: 3.0 },
    { symbol: "MF_118968", qty: 3.0 },
    { symbol: "HDFCBANK",         qty: 5 },
    { symbol: "TCS",              qty: 2 },
  ],
  balanced: [
    { symbol: "RELIANCE",         qty: 8 },
    { symbol: "TCS",              qty: 3 },
    { symbol: "HDFCBANK",         qty: 10 },
    { symbol: "INFY",             qty: 6 },
    { symbol: "ITC",              qty: 40 },
    { symbol: "MF_120716", qty: 1.5 },
  ],
  bold: [
    { symbol: "TMPV",        qty: 20 },
    { symbol: "ETERNAL",     qty: 100 },
    { symbol: "ADANIENT",    qty: 5 },
    { symbol: "RELIANCE",    qty: 5 },
    { symbol: "BAJFINANCE",  qty: 2 },
    { symbol: "PAYTM",       qty: 15 },
  ],
};
