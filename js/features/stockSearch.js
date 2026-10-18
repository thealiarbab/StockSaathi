// =============================================================================
// MARKETS SEARCH ENGINE — runs in the browser, answers in a few milliseconds.
//
// Two layers:
//   1. Understanding: phrases like "under ₹100", "low budget", "best
//      performing", "high dividend", "debt free", "bluechip banks", "stocks
//      like TCS" become filters and a sort order, each shown to the student as
//      a removable chip so they can see how the box read their words.
//   2. Matching: what is left of the query is matched against tickers,
//      company names, initials (SBI, TCS, HUL) and everyday brand names (Jio,
//      Zomato, DMart), tolerating typos ("relaince"), and ranked by how well
//      it matched, with bigger companies first on ties.
//
// Prices and fundamentals come from one cached file (search_snapshot() via
// /api/ai?op=search-snapshot), refreshed after the nightly NSE import; live
// quotes on screen override its price.
// =============================================================================

import { getCanonicalCategory } from "../data/universe.js";

// ---------------------------------------------------------------------------
// Snapshot: symbol -> { p, d, r2w, mc, pe, dy, roe, de, b, hi, lo }
let _snap = null;
let _snapAsOf = null;
let _snapPromise = null;
const _snapListeners = new Set();

export function loadSearchSnapshot() {
  if (_snap) return Promise.resolve(_snap);
  if (_snapPromise) return _snapPromise;
  // v=2: one character per day in the chart shape (v1 used two digits).
  _snapPromise = fetch("/api/ai?op=search-snapshot&v=2")
    .then(r => (r.ok ? r.json() : Promise.reject(new Error("http_" + r.status))))
    .then(d => {
      const cols = d.cols || [];
      const m = new Map();
      for (const row of d.rows || []) {
        const o = {};
        for (let i = 1; i < cols.length; i++) if (row[i] != null) o[cols[i]] = row[i];
        m.set(row[0], o);
      }
      _snap = m;
      _snapAsOf = d.asOf || null;
      for (const fn of _snapListeners) { try { fn(); } catch {} }
      return m;
    })
    .catch(e => { _snapPromise = null; throw e; });
  return _snapPromise;
}
export function onSearchSnapshot(fn) { _snapListeners.add(fn); return () => _snapListeners.delete(fn); }
export function searchSnapshotReady() { return !!_snap; }
export function searchSnapshotAsOf() { return _snapAsOf; }
export function snapOf(sym) { return _snap?.get(sym) || null; }

// Real NSE daily closes for the last ~3 weeks, as a 0-35 shape (the server
// packs each day into one 0-9a-z character). Enough for the small list
// charts, which only show the shape and whether it ended up or down.
const _shapes = new Map();
export function dailyShape(sym) {
  const hit = _shapes.get(sym);
  if (hit) return hit;
  const sk = _snap?.get(sym)?.sk;
  if (!sk || sk.length < 2) return [];
  const out = new Array(sk.length);
  for (let i = 0; i < sk.length; i++) out[i] = parseInt(sk[i], 36);
  _shapes.set(sym, out);
  return out;
}

// ---------------------------------------------------------------------------
// Text helpers
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[₹]/g, " rs ")
    .replace(/[^a-z0-9.%<>\s-]/g, " ")
    .replace(/(\d),(\d)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}
const NAME_DROP = new Set(["limited", "ltd", "ltd.", "pvt", "private", "the", "co", "corpn", "inc", "plc"]);
const ACRO_SKIP = new Set(["and", "of", "the", "limited", "ltd", "india", "co", "company"]);
function nameWords(name) {
  return norm(name).replace(/[.\-]/g, " ").split(" ").filter(w => w && !NAME_DROP.has(w));
}

// Optimal-string-alignment distance, stops early once it can't be <= max.
function editDistance(a, b, max) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2 = null, prev = new Array(lb + 1), cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev2 || new Array(lb + 1);
    prev2 = prev; prev = cur; cur = t;
  }
  return prev[lb];
}

// ---------------------------------------------------------------------------
// Everyday names students type -> NSE symbols. Entries whose symbol is not in
// the loaded universe are ignored, so a wrong guess here can't show junk.
const BRANDS = {
  jio: ["RELIANCE", "JIOFIN"], "reliance jio": ["RELIANCE"], "jio financial": ["JIOFIN"], ril: ["RELIANCE"],
  airtel: ["BHARTIARTL"], bharti: ["BHARTIARTL"],
  sbi: ["SBIN"], "state bank": ["SBIN"], hul: ["HINDUNILVR"], unilever: ["HINDUNILVR"],
  "l and t": ["LT"], lnt: ["LT"], larsen: ["LT"], "m and m": ["M&M"], mahindra: ["M&M"],
  maruti: ["MARUTI"], suzuki: ["MARUTI"], infosys: ["INFY"], hcl: ["HCLTECH"], "tech mahindra": ["TECHM"],
  "bajaj finance": ["BAJFINANCE"], "bajaj finserv": ["BAJAJFINSV"], "bajaj auto": ["BAJAJ-AUTO"],
  paytm: ["PAYTM"], zomato: ["ETERNAL"], blinkit: ["ETERNAL"], eternal: ["ETERNAL"], swiggy: ["SWIGGY"],
  nykaa: ["NYKAA"], policybazaar: ["POLICYBZR"], dmart: ["DMART"], "d mart": ["DMART"],
  "tata motors": ["TMPV", "TMCV"], tatamotors: ["TMPV", "TMCV"], tanishq: ["TITAN"],
  maggi: ["NESTLEIND"], nestle: ["NESTLEIND"], colgate: ["COLPAL"], fevicol: ["PIDILITIND"], pidilite: ["PIDILITIND"],
  "ola electric": ["OLAELEC"], ola: ["OLAELEC"], vedanta: ["VEDL"], "power grid": ["POWERGRID"],
  "coal india": ["COALINDIA"], bel: ["BEL"], "bharat electronics": ["BEL"], hal: ["HAL"],
  "hindustan aeronautics": ["HAL"], "mazagon dock": ["MAZDOCK"], mazagon: ["MAZDOCK"],
  vodafone: ["IDEA"], "vodafone idea": ["IDEA"], vi: ["IDEA"], "rail vikas": ["RVNL"], lic: ["LICI"],
  indigo: ["INDIGO"], interglobe: ["INDIGO"], zudio: ["TRENT"], westside: ["TRENT"],
  hero: ["HEROMOTOCO"], "royal enfield": ["EICHERMOT"], enfield: ["EICHERMOT"], eicher: ["EICHERMOT"],
  ultratech: ["ULTRACEMCO"], "sun pharma": ["SUNPHARMA"], "dr reddy": ["DRREDDY"], "dr reddys": ["DRREDDY"],
  apollo: ["APOLLOHOSP"], jockey: ["PAGEIND"], dominos: ["JUBLFOOD"], "dominos pizza": ["JUBLFOOD"],
  zee: ["ZEEL"], pvr: ["PVRINOX"], inox: ["PVRINOX"], "angel one": ["ANGELONE"], "angel broking": ["ANGELONE"],
  "asian paints": ["ASIANPAINT"], "hdfc bank": ["HDFCBANK"], "icici bank": ["ICICIBANK"], "kotak bank": ["KOTAKBANK"],
  "axis bank": ["AXISBANK"], "yes bank": ["YESBANK"], "tata steel": ["TATASTEEL"], "tata power": ["TATAPOWER"],
  "jsw steel": ["JSWSTEEL"], "adani ports": ["ADANIPORTS"], "adani green": ["ADANIGREEN"], "adani power": ["ADANIPOWER"],
  "adani enterprises": ["ADANIENT"], "indian oil": ["IOC"], iocl: ["IOC"], bpcl: ["BPCL"], hpcl: ["HINDPETRO"],
  "bank of baroda": ["BANKBARODA"], bob: ["BANKBARODA"], pnb: ["PNB"], "punjab national": ["PNB"],
  "hindustan zinc": ["HINDZINC"], "bharat petroleum": ["BPCL"], mrf: ["MRF"], groww: ["GROWW"],
  "urban company": ["URBANCO"], lenskart: ["LENSKART"], mobikwik: ["MOBIKWIK"], "hyundai": ["HYUNDAI"],
  "tata consultancy": ["TCS"], "tata elxsi": ["TATAELXSI"], "tata chemicals": ["TATACHEM"],
  "tata communications": ["TATACOMM"], "tata consumer": ["TATACONSUM"], "tata tea": ["TATACONSUM"],
};
// Old names that teens still search by.
const FORMER = { zomato: ["ETERNAL"], tatamotors: ["TMPV", "TMCV"], "tata motors": ["TMPV", "TMCV"], "one97": ["PAYTM"], "fsn": ["NYKAA"], "pb fintech": ["POLICYBZR"] };

// ---------------------------------------------------------------------------
// Understanding layer. Each rule turns a phrase into a filter or sort and a
// chip. `ambiguous` rules (sector words) only filter when no other words are
// left, so "tata power" still finds Tata Power by name.
const SECTOR_WORDS = [
  [/\b(banks?|banking|psu banks?|private banks?)\b/, "Banking"],
  [/\b(it|tech|technology|software|saas|it services)\b/, "IT"],
  [/\b(pharma|pharmaceuticals?|drugs?|medicines?)\b/, "Pharma"],
  [/\b(auto|automobiles?|cars?|vehicles?|ev|evs|electric vehicles?|bikes?|two wheelers?)\b/, "Auto"],
  [/\b(fmcg|consumer goods|food|foods|beverages?)\b/, "FMCG"],
  [/\b(metals?|steel|aluminium|aluminum|copper|mining|zinc)\b/, "Metals"],
  [/\b(oil|gas|oil and gas|petroleum|refiners?|refinery)\b/, "Oil & Gas"],
  [/\b(power|electricity|utilities|utility|renewables?|solar|green energy|energy)\b/, "Power"],
  [/\b(real estate|realty|property|housing|builders?)\b/, "Real Estate"],
  [/\b(cement)\b/, "Cement"],
  [/\b(telecom|telecommunications?|5g)\b/, "Telecom"],
  [/\b(insurance|insurers?)\b/, "Insurance"],
  [/\b(nbfcs?|lenders?|lending|finance companies)\b/, "NBFC"],
  [/\b(chemicals?|specialty chemicals?|fertili[sz]ers?|agro ?chemicals?|paints?)\b/, "Chemicals"],
  [/\b(infra|infrastructure|construction|epc|railways?|rail)\b/, "Infrastructure"],
  [/\b(defen[cs]e|defence stocks)\b/, "Infrastructure"],
  [/\b(healthcare|hospitals?|diagnostics?)\b/, "Healthcare"],
  [/\b(retail|retailers?|e ?commerce|shopping)\b/, "Retail"],
  [/\b(aviation|airlines?)\b/, "Aviation"],
  [/\b(textiles?|apparel|clothing)\b/, "Textiles"],
  [/\b(jewell?ery|gold jewell?ery)\b/, "Jewellery"],
  [/\b(consumer durables|electronics|appliances?)\b/, "Consumer Durables"],
  [/\b(financial services|brokers?|exchanges?|amcs?|fintech)\b/, "Financial Services"],
];

const STOP = new Set(("best good great top nice stock stocks share shares equity equities company companies firm firms " +
  "buy buying to for in on of the a an with and or me show list find give which what whats some any should i can " +
  "invest investing investment investments now right currently india indian nse bse market markets rate " +
  "beginner beginners student students new newbie long short term longterm shortterm this year years month months week " +
  "worth recommended recommend suggest suggestions options option kaun konsa kon sa accha acche achha achhe " +
  "wala wale ke ki ka me hai mein sabse that are is be to my portfolio buy sell " +
  "most least more less very much many highest lowest high low max min maximum minimum lot lots amount " +
  "has have having who whose where how why does do did get got from by at as it's its their them they " +
  "please pls plz tell know about all").split(" "));

function parseAmount(raw) {
  if (!raw) return null;
  let s = String(raw).toLowerCase().replace(/rs\.?|inr|rupees?|₹/g, "").trim();
  let mult = 1;
  if (/k$/.test(s) || /thousand$/.test(s)) { mult = 1000; s = s.replace(/k$|thousand$/, ""); }
  if (/lakh$|lac$/.test(s)) { mult = 100000; s = s.replace(/lakh$|lac$/, ""); }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n * mult : null;
}
const AMT = String.raw`(?:rs\.?\s*|inr\s*)?(\d+(?:\.\d+)?\s*(?:k|thousand|lakh|lac)?)(?:\s*(?:rs|rupees?|inr))?`;

function inr(n) {
  return "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: n < 10 ? 2 : 0 });
}

function understand(qn) {
  let rest = " " + qn + " ";
  const chips = [];
  const f = {};          // filters
  let sort = null;       // { key, dir, label }
  let kind = null;
  let note = null;
  const take = (re) => {
    const m = rest.match(re);
    if (!m) return null;
    rest = rest.replace(m[0], " ");
    return m;
  };

  // Price range
  let m;
  if ((m = take(new RegExp(String.raw`\b(?:between|from)\s+${AMT}\s+(?:and|to|-)\s+${AMT}`)))) {
    const a = parseAmount(m[1]), b = parseAmount(m[2]);
    if (a && b) { f.pMin = Math.min(a, b); f.pMax = Math.max(a, b); chips.push({ id: "price", label: `Price ${inr(f.pMin)}–${inr(f.pMax)}`, phrase: m[0].trim() }); }
  }
  if (f.pMax == null && (m = take(new RegExp(String.raw`(?:\b(?:under|below|less than|lower than|within|upto|up to|max|maximum|cheaper than|not more than|andar)\s*|<\s*)${AMT}`)))) {
    const a = parseAmount(m[1]);
    if (a) { f.pMax = a; chips.push({ id: "price", label: `Price under ${inr(a)}`, phrase: m[0].trim() }); }
  }
  if (f.pMin == null && (m = take(new RegExp(String.raw`(?:\b(?:above|over|more than|greater than|min|minimum|costlier than)\s*|>\s*)${AMT}`)))) {
    const a = parseAmount(m[1]);
    if (a) { f.pMin = a; chips.push({ id: "pricemin", label: `Price over ${inr(a)}`, phrase: m[0].trim() }); }
  }
  if (f.pMax == null && (m = take(new RegExp(String.raw`\b${AMT}\s*(?:rs|rupees?|rupay|ka|ke|wale|wala)?\s*(?:stocks?|shares?)\b`))) && /rs|rupee|rupay|ka|ke|wal/.test(m[0])) {
    const a = parseAmount(m[1]);
    if (a) { f.pMax = a; chips.push({ id: "price", label: `Price under ${inr(a)}`, phrase: m[0].trim() }); }
  }
  if ((m = take(/\b(low|cheap)[\s-]*(p\/?e|pe ratio|valuations?)\b|\b(undervalued|value stocks?|value picks?)\b/))) {
    f.peMax = 18; chips.push({ id: "pe", label: "P/E under 18", phrase: m[0].trim() });
  }
  if ((m = take(/\bpenny\b(\s+stocks?)?/))) {
    f.pMax = Math.min(f.pMax ?? 1e9, 20);
    chips.push({ id: "price", label: "Penny stocks: under ₹20, very risky", phrase: m[0].trim() });
  }
  if (f.pMax == null && (m = take(/\b(low|small|tight|limited|less|kam)\s*(budget|money|paisa|price|priced|cost)\b|\b(budget|affordable|cheap|cheapest|inexpensive|pocket friendly|sasta|saste|sasti|low price|low priced|lowest price)\b/))) {
    f.pMax = 500;
    chips.push({ id: "price", label: "Price under ₹500", phrase: m[0].trim() });
    if (!sort) note = "Cheaper shares aren't better value by themselves. These are sorted biggest company first, so well-known names come before tiny ones.";
  }
  if ((m = take(/\b(expensive|costly|costliest|priciest|highest price|high price|mehenga|mehnge)\b/))) {
    sort = { key: "p", dir: -1, label: "Highest share price first" };
    chips.push({ id: "sort", label: sort.label, phrase: m[0].trim() });
  }

  // Performance / movement
  if ((m = take(/\b(top )?(gainers?|gaining|up today|green today|rising today|winners today|best today|today'?s? (top|best|winners|gainers))\b/))) {
    sort = { key: "d", dir: -1, label: "Up the most today" };
    chips.push({ id: "sort", label: sort.label, phrase: m[0].trim() });
  } else if ((m = take(/\b(top )?(losers?|losing|falling|fell|down today|red today|crash(ing|ed)?|worst today|today'?s? (worst|losers))\b/))) {
    sort = { key: "d", dir: 1, label: "Down the most today" };
    chips.push({ id: "sort", label: sort.label, phrase: m[0].trim() });
  } else if ((m = take(/\b(high|best|top|strong|good|great)[\s-]*(perform\w*|returns?|growth|growing|gain\w*)\b|\b(perform(ing|ers?)|outperform\w*|momentum|trending|hot|rising|going up|uptrend|bullish|multibaggers?|winners|growing fast|fast growing|high growth|rocket(ing)?)\b/))) {
    sort = { key: "r2w", dir: -1, label: "Up the most in 2 weeks" };
    chips.push({ id: "sort", label: sort.label, phrase: m[0].trim() });
    note = "Past gains don't predict the future. A stock that jumped in the last 2 weeks can just as easily fall next.";
  } else if ((m = take(/\b(worst|poor|bad|weak)[\s-]*(perform\w*|returns?)\b|\b(underperform\w*|downtrend|bearish|beaten down)\b/))) {
    sort = { key: "r2w", dir: 1, label: "Down the most in 2 weeks" };
    chips.push({ id: "sort", label: sort.label, phrase: m[0].trim() });
  }
  if ((m = take(/\b(near|at|close to|hitting)?\s*(52[\s-]?(week|wk|w)[\s-]?high|year high|all[\s-]?time[\s-]?high|ath)\b/))) {
    sort = { key: "nearHi", dir: -1, label: "Closest to 52-week high" };
    chips.push({ id: "sort", label: sort.label, phrase: m[0].trim() });
  } else if ((m = take(/\b(near|at|close to|hitting)?\s*(52[\s-]?(week|wk|w)[\s-]?low|year low)\b|\b(discount(ed)?|dips?|fallen|beaten|bottomed|sale)\b/))) {
    sort = { key: "nearLo", dir: -1, label: "Closest to 52-week low" };
    chips.push({ id: "sort", label: sort.label, phrase: m[0].trim() });
  }

  // "company with most debt", "highest pe", "lowest roe", "least volatile":
  // a direction word, up to three filler words, then a measure.
  const METRICS = [
    [/(debts?|loans?|borrowings?|borrowed|leverage[d]?|debt to equity|d\/?e)/, "de", "debt", "Most debt first (debt compared to the company's own money)", "Least debt first (debt compared to the company's own money)"],
    [/(p\/?e|pe ratio|price to earnings|valuations?)/, "pe", "pe", "Highest P/E first", "Lowest P/E first"],
    [/(roe|return on equity|profitab\w*)/, "roe", "roe", "Highest return on equity first", "Lowest return on equity first"],
    [/(dividends?|dividend yield|yield|payouts?)/, "dy", "div", "Highest dividend first", "Lowest dividend first"],
    [/(volatil\w*|beta|risk\w*|swings?)/, "b", "beta", "Swings the most first", "Swings the least first"],
    [/(valuable|valued|market cap\w*|mcap|market value)/, "mc", "size", "Biggest company first", "Smallest company first"],
  ];
  for (const [mre, key, id, hiLabel, loLabel] of METRICS) {
    const re = new RegExp(String.raw`\b(most|highest|max(?:imum)?|biggest|largest|more|greatest|top|least|lowest|min(?:imum)?|smallest|fewest|less)\s+(?:\w+\s+){0,3}?` + mre.source + String.raw`\b`);
    if ((m = take(re))) {
      const up = !/^(least|lowest|min|minimum|smallest|fewest|less)$/.test(m[1]);
      sort = { key, dir: up ? -1 : 1, label: up ? hiLabel : loLabel };
      chips.push({ id: "sort", label: sort.label, phrase: m[0].trim() });
      break;
    }
  }

  // Size / quality / income
  if ((m = take(/\bnifty ?50\b|\bsensex\b/))) {
    f.tierMin = 5; chips.push({ id: "size", label: "Nifty 50 companies", phrase: m[0].trim() });
  } else if ((m = take(/\b(blue ?chips?|large ?caps?|big|biggest|largest|giants?|top companies|well known|famous|established|safe|safest|stable|reliable|trusted|for beginners?|beginner friendly|nifty ?100)\b/))) {
    f.tierMin = 4; chips.push({ id: "size", label: "Big, established companies", phrase: m[0].trim() });
  } else if ((m = take(/\bmid ?caps?\b/))) {
    f.cap = "mid"; chips.push({ id: "size", label: "Mid-sized companies", phrase: m[0].trim() });
  } else if ((m = take(/\bsmall ?caps?\b|\bsmall companies\b|\bmicro ?caps?\b/))) {
    f.cap = "micro"; chips.push({ id: "size", label: "Small companies", phrase: m[0].trim() });
  }
  if ((m = take(/\b(high )?(dividends?|dividend yield|yield|passive income|income|payouts?)\b/))) {
    f.dyMin = 2; if (!sort) sort = { key: "dy", dir: -1, label: "Highest dividend first" };
    chips.push({ id: "div", label: "Dividend 2%+ a year", phrase: m[0].trim() });
  }
  if ((m = take(/\b(low|less|little|zero|no)[\s-]*(debt|loans?|borrowings?)\b|\bdebt[\s-]*free\b/))) {
    f.deMax = /zero|no|free/.test(m[0]) ? 0.05 : 0.3;
    chips.push({ id: "debt", label: f.deMax < 0.1 ? "Almost no debt" : "Low debt", phrase: m[0].trim() });
  }
  if ((m = take(/\b(high )?(roe|return on equity)\b|\b(profitable|quality|efficient|strong fundamentals|good fundamentals)\b/))) {
    f.roeMin = 15; chips.push({ id: "roe", label: "Return on equity 15%+", phrase: m[0].trim() });
  }
  if ((m = take(/\b(low|less)[\s-]*(risk|volatility|volatile)\b|\b(defensive|steady)\b/))) {
    f.betaMax = 0.9; chips.push({ id: "beta", label: "Moves less than the market", phrase: m[0].trim() });
  } else if ((m = take(/\b(high|more)[\s-]*(risk|volatility)\b|\b(risky|volatile|aggressive)\b/))) {
    f.betaMin = 1.3; chips.push({ id: "beta", label: "Moves more than the market", phrase: m[0].trim() });
  }

  if ((m = take(/\b(all|any|every)[\s-]*(sizes?|companies)\b|\binclude small\b/))) f.allSizes = true;

  // Kind
  if ((m = take(/\b(mutual funds?|mfs?|sips?|elss)\b/))) { kind = "MF"; chips.push({ id: "kind", label: "Mutual funds", phrase: m[0].trim() }); }
  else if ((m = take(/\b(etfs?|exchange traded funds?|index funds?)\b/))) { kind = "ETF"; chips.push({ id: "kind", label: "ETFs", phrase: m[0].trim() }); }
  // "stocks"/"shares" stay in the text (they are filler words) but mean
  // companies only: no funds in "low budget stocks".
  const sharesOnly = !kind && /\b(stocks?|shares?|equit(y|ies)|compan(y|ies))\b/.test(rest);

  // "stocks like TCS" / "similar to infosys" / "alternatives to zomato"
  let like = null;
  if ((m = take(/\b(?:like|similar to|similar|alternatives? (?:to|for)|competitors? (?:of|to)|peers? (?:of|to)|rivals? (?:of|to))\s+([a-z0-9&.\- ]{2,30}?)\s*$/))) {
    like = m[1].trim();
  }

  // Sector words: soft unless nothing else is left.
  const sectors = [];
  for (const [re, cat] of SECTOR_WORDS) {
    const mm = rest.match(re);
    if (mm) sectors.push({ cat, phrase: mm[0], re });
  }
  return { rest: rest.replace(/\s+/g, " ").trim(), chips, f, sort, kind, note, like, sectors, sharesOnly };
}

// ---------------------------------------------------------------------------
// Index over the instrument list (rebuilt when the list changes).
let _idx = null;

function buildIndex(list) {
  const vocab = new Map();          // word -> [[id, field], ...]
  const add = (w, id, field) => {
    if (!w) return;
    let p = vocab.get(w);
    if (!p) { p = []; vocab.set(w, p); }
    p.push(id, field);
  };
  const bySym = new Map();
  const compact = new Array(list.length);
  const symc = new Array(list.length);
  const words = new Array(list.length);
  for (let id = 0; id < list.length; id++) {
    const it = list[id];
    const sym = String(it.symbol || "").toLowerCase();
    bySym.set(it.symbol, id);
    const ws = nameWords(it.name || it.symbol);
    words[id] = ws;
    compact[id] = ws.join("");
    symc[id] = it.kind === "MF" ? "" : sym.replace(/[^a-z0-9]/g, "");
    if (it.kind !== "MF") add(sym, id, 4);
    const symClean = sym.replace(/[^a-z0-9]/g, "");
    if (symClean !== sym && it.kind !== "MF") add(symClean, id, 4);
    ws.forEach((w, i) => add(w.replace(/[.\-]/g, ""), id, i === 0 ? 3 : 2));
    const acro = ws.filter(w => !ACRO_SKIP.has(w)).map(w => w[0]).join("");
    if (acro.length >= 2 && acro.length <= 6 && it.kind !== "MF") add(acro, id, 1);
  }
  const aliasHits = new Map();      // alias phrase -> ids
  for (const [phrase, syms] of [...Object.entries(BRANDS), ...Object.entries(FORMER)]) {
    const ids = syms.map(s => bySym.get(s)).filter(x => x != null);
    if (ids.length) aliasHits.set(phrase, ids);
    if (ids.length && !phrase.includes(" ")) for (const id of ids) add(phrase, id, 5);
  }
  const sorted = [...vocab.keys()].sort();
  const byLen = [];
  for (const w of sorted) (byLen[w.length] || (byLen[w.length] = [])).push(w);
  return { list, vocab, sorted, byLen, bySym, compact, symc, words, aliasHits, n: list.length, first: list[0], last: list[list.length - 1] };
}
function indexFor(list) {
  if (!_idx || _idx.n !== list.length || _idx.first !== list[0] || _idx.last !== list[list.length - 1]) _idx = buildIndex(list);
  return _idx;
}

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

const FIELD_W = { 5: 1.0, 4: 1.0, 3: 0.85, 2: 0.7, 1: 0.8 };

// Scores for one query word: Map id -> best score.
function matchToken(ix, t, allowFuzzy) {
  const out = new Map();
  const put = (w, base) => {
    const p = ix.vocab.get(w);
    if (!p) return;
    for (let i = 0; i < p.length; i += 2) {
      const s = base * FIELD_W[p[i + 1]];
      if ((out.get(p[i]) || 0) < s) out.set(p[i], s);
    }
  };
  // exact
  put(t, 100);
  // prefix
  if (t.length >= 1) {
    let i = lowerBound(ix.sorted, t);
    let n = 0;
    for (; i < ix.sorted.length && ix.sorted[i].startsWith(t) && n < 4000; i++, n++) {
      const w = ix.sorted[i];
      if (w === t) continue;
      put(w, 45 + 35 * (t.length / w.length));
    }
  }
  // inside joined names and tickers: "bajajfin", "hdfcbank", "bees" in NIFTYBEES
  if (t.length >= 3) {
    for (let id = 0; id < ix.compact.length; id++) {
      if (out.has(id)) continue;
      if ((t.length >= 4 && ix.compact[id].includes(t)) || ix.symc[id].includes(t)) out.set(id, 30);
    }
  }
  // typos
  if (allowFuzzy && t.length >= 3 && !/^\d+$/.test(t)) {
    const max = t.length >= 8 ? 2 : 1;
    for (let len = t.length - max; len <= t.length + max; len++) {
      for (const w of ix.byLen[len] || []) {
        if (w[0] !== t[0] && w[1] !== t[1]) continue;
        const d = editDistance(t, w, max);
        if (d > 0 && d <= max) put(w, d === 1 ? 38 : 24);
      }
    }
  }
  return out;
}

function suggestWord(ix, t) {
  if (t.length < 3) return null;
  let best = null, bestD = 3, bestN = 0;
  for (let len = Math.max(3, t.length - 2); len <= t.length + 2; len++) {
    for (const w of ix.byLen[len] || []) {
      if (w[0] !== t[0] && w[1] !== t[1] && w[0] !== t[1]) continue;
      const d = editDistance(t, w, 2);
      if (d > 2) continue;
      const n = ix.vocab.get(w).length;
      if (d < bestD || (d === bestD && n > bestN)) { best = w; bestD = d; bestN = n; }
    }
  }
  return bestD <= 2 ? best : null;
}

function tierOf(it) {
  const n = Number(it.idx) || 0;
  if (n & 1) return 5; if (n & 2) return 4; if (n & 8) return 3; if (n & 4) return 2; if (n & 16) return 1; return 0;
}
function prominence(it, s) {
  return tierOf(it) * 4 + (s?.mc ? Math.log10(s.mc + 1) * 1.5 : 0) + (it.kind === "MF" ? -25 : 0);
}

// ---------------------------------------------------------------------------
/**
 * search(query, universe, { filter, priceOf, changeOf })
 *   universe: the full instrument list (a stable array, indexed once).
 *   filter:   optional instrument -> bool for the open tab / sector pill.
 * Returns { results, chips, sortLabel, note, didYouMean, kind, needsSnapshot,
 *           strong, understood }
 */
/** Build the index ahead of the first keystroke (call when the browser is idle). */
export function warmSearchIndex(list) { if (list?.length) indexFor(list); }

export function search(query, list, opts = {}) {
  const keep = opts.filter || null;
  const t0 = performance.now();
  const qn = norm(query);
  const res = { results: [], chips: [], sortLabel: null, note: null, didYouMean: null, kind: null, needsSnapshot: false, strong: false, understood: false, ms: 0 };
  if (!qn) { res.results = keep ? list.filter(keep) : list; return res; }

  const u = understand(qn);
  res.chips = u.chips.slice();
  res.note = u.note;
  res.kind = u.kind;
  const ix = indexFor(list);
  const priceOf = (it) => opts.priceOf?.(it.symbol) ?? snapOf(it.symbol)?.p ?? (it.kind === "MF" ? it.nav : null);
  const changeOf = (it) => opts.changeOf?.(it.symbol) ?? snapOf(it.symbol)?.d ?? null;

  // Words left after the understood phrases.
  let tokens = u.rest.split(" ").map(w => w.replace(/^[.\-]+|[.\-]+$/g, "")).filter(Boolean);
  const raw = tokens.slice();
  tokens = tokens.filter(w => !STOP.has(w));
  // Only sector words left → it's a sector filter ("it stocks under 500").
  let sectorFilter = null;
  if (u.sectors.length) {
    let leftover = " " + tokens.join(" ") + " ";
    for (const s of u.sectors) leftover = leftover.replace(new RegExp(s.re.source, "g"), " ");
    if (!leftover.trim()) {
      sectorFilter = new Set(u.sectors.map(s => s.cat));
      tokens = [];
      for (const s of u.sectors) res.chips.push({ id: "sector:" + s.cat, label: s.cat, phrase: s.phrase.trim() });
    }
  }
  // "like X": find X, then show its sector.
  let likeOf = null;
  if (u.like) {
    const lr = search(u.like, list, { ...opts, filter: (it) => it.kind === "EQUITY" });
    likeOf = lr.results[0] || null;
    if (likeOf) {
      const cat = getCanonicalCategory(likeOf) || likeOf.sector;
      res.chips.push({ id: "like", label: `Same sector as ${likeOf.symbol}: ${cat}`, phrase: "" });
      sectorFilter = new Set([cat]);
    }
  }
  if (!tokens.length && raw.length && !res.chips.length) {
    // Only filler words ("best stocks"): show the biggest companies and say so.
    res.chips.push({ id: "size", label: "Biggest companies first", phrase: raw.join(" ") });
    res.note = "There's no single \"best\" stock. Here are the biggest companies; try \"best performing\", \"high dividend\" or \"under ₹500\".";
  }
  res.understood = res.chips.length > 0;

  // Text matching
  let scores = null;
  if (tokens.length) {
    const qj = tokens.join(" ");
    // Multi-word brand names first ("tata motors", "asian paints").
    const aliasIds = new Set();
    for (const [phrase, ids] of ix.aliasHits) {
      if (phrase.length >= 2 && (qj === phrase || (phrase.includes(" ") && qj.includes(phrase)))) ids.forEach(i => aliasIds.add(i));
    }
    const perToken = tokens.map(t => matchToken(ix, t, false));
    // Retry the words that matched nothing, allowing typos.
    tokens.forEach((t, i) => { if (perToken[i].size === 0) perToken[i] = matchToken(ix, t, true); });
    scores = new Map();
    const need = perToken.filter(m => m.size > 0);
    if (need.length) {
      // every word must match (AND); if that leaves nothing, any word (OR)
      const base = need.reduce((a, b) => (a.size <= b.size ? a : b));
      for (const id of base.keys()) {
        let s = 0, ok = true;
        for (const m of need) { const v = m.get(id); if (v == null) { ok = false; break; } s += v; }
        if (ok) scores.set(id, s);
      }
      if (!scores.size && need.length > 1) {
        for (const m of need) for (const [id, v] of m) scores.set(id, (scores.get(id) || 0) + v * 0.6);
      }
    }
    for (const id of aliasIds) scores.set(id, (scores.get(id) || 0) + 260);
    // Whole query as one word: "hdfcbank", "hdfc bank", "bajaj finance"
    const qc = tokens.join("");
    // A whole name word ("tata", "adani") is a group: rank the group by size,
    // not by whose ticker happens to start with it.
    const qcIsWord = ix.vocab.has(qc) && !ix.bySym.has(qc.toUpperCase());
    if (qc.length >= 2) {
      for (const [id, s] of scores) {
        const it = list[id];
        const sym = it.symbol.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (sym === qc) scores.set(id, s + 300);
        else if (sym.startsWith(qc) && !qcIsWord) scores.set(id, s + 60);
        if (ix.compact[id] === qc) scores.set(id, scores.get(id) + 200);
        else if (ix.compact[id].startsWith(qc) && !qcIsWord) scores.set(id, scores.get(id) + 70);
      }
    }
    // Typos the student can fix in one tap.
    const dym = tokens.map((t, i) => {
      if (perToken[i].size && [...perToken[i].values()].some(v => v >= 45)) return t;
      const w = suggestWord(ix, t);
      return w && w.length >= t.length ? w : t;
    });
    if (dym.join(" ") !== tokens.join(" ")) res.didYouMean = dym.join(" ");
  }

  // Filters
  const f = u.f;
  const needsSnap = f.pMax != null || f.pMin != null || f.dyMin != null || f.deMax != null || f.roeMin != null || f.peMax != null || f.betaMax != null || f.betaMin != null || (u.sort && u.sort.key !== "d");
  if (needsSnap && !_snap) { res.needsSnapshot = true; loadSearchSnapshot().catch(() => {}); }
  const metricFilter = f.dyMin != null || f.deMax != null || f.roeMin != null || f.peMax != null || f.betaMax != null || f.betaMin != null
    || (u.sort && u.sort.key !== "d" && u.sort.key !== "p");
  const pass = (it) => {
    if (keep && !keep(it)) return false;
    if (u.kind && it.kind !== u.kind) return false;
    // Funds have a unit value (NAV), not a share price: price words never mean them.
    if (it.kind === "MF" && !u.kind && (u.sharesOnly || f.pMax != null || f.pMin != null || u.sort)) return false;
    if (u.sharesOnly && it.kind === "ETF") return false;
    if (sectorFilter && !sectorFilter.has(getCanonicalCategory(it))) return false;
    if (likeOf && it.symbol === likeOf.symbol) return false;
    if (f.tierMin && tierOf(it) < f.tierMin) return false;
    if (f.cap && (it.capBucket || it.cap_bucket) !== f.cap) return false;
    if (!_snap) return true;   // price-based filters wait for the snapshot
    const s = snapOf(it.symbol) || {};
    const p = priceOf(it);
    // Fundamentals rows with no NSE close are often another company's numbers
    // under a stray ticker; never rank on them.
    if (metricFilter && s.p == null) return false;
    if (f.pMax != null && !(p > 0 && p <= f.pMax)) return false;
    if (f.pMin != null && !(p >= f.pMin)) return false;
    if (f.dyMin != null && !(s.dy >= f.dyMin)) return false;
    if (f.deMax != null && !(s.de != null && s.de <= f.deMax)) return false;
    if (f.roeMin != null && !(s.roe >= f.roeMin)) return false;
    if (f.peMax != null && !(s.pe > 0 && s.pe <= f.peMax)) return false;
    if (f.betaMax != null && !(s.b != null && s.b <= f.betaMax)) return false;
    if (f.betaMin != null && !(s.b >= f.betaMin)) return false;
    return true;
  };

  let out;
  if (scores) {
    out = [];
    for (const [id, s] of scores) { const it = list[id]; if (pass(it)) out.push([it, s + prominence(it, snapOf(it.symbol))]); }
  } else {
    out = [];
    for (const it of list) if (pass(it)) out.push([it, prominence(it, snapOf(it.symbol))]);
  }

  // Order
  const sort = u.sort;
  if (sort) {
    const val = (it) => {
      const s = snapOf(it.symbol) || {};
      switch (sort.key) {
        case "d": return changeOf(it);
        case "r2w": return s.r2w;
        case "p": return priceOf(it);
        case "dy": return s.dy;
        case "de": return s.de;
        case "pe": return s.pe > 0 ? s.pe : null;
        case "roe": return s.roe;
        case "b": return s.b;
        case "mc": return s.mc;
        case "nearHi": { const p = priceOf(it); return s.hi > 0 && p > 0 ? p / s.hi : null; }
        case "nearLo": { const p = priceOf(it); return s.lo > 0 && p > 0 ? s.lo / p : null; }
        default: return null;
      }
    };
    // Ranked lists (top gainers, best performing, highest dividend...): only
    // companies in a Nifty index or worth ₹10,000 crore+, unless the student
    // asked for small ones or typed "all sizes". Tiny thinly traded shares
    // otherwise fill the top with one-off jumps.
    if (!f.cap && !f.tierMin && !f.allSizes && !scores && f.pMax == null) {
      out = out.filter(([it]) => it.kind !== "EQUITY" || tierOf(it) >= 1 || (snapOf(it.symbol)?.mc || 0) >= 10000);
      res.chips.push({ id: "floor", label: "Bigger companies only", phrase: "", add: "all sizes" });
    }
    out = out.map(([it, s]) => [it, s, val(it)]).filter(r => r[2] != null && Number.isFinite(r[2]));
    if (sort.dir === 1) out.sort((a, b) => a[2] - b[2] || b[1] - a[1]);
    else out.sort((a, b) => b[2] - a[2] || b[1] - a[1]);
    res.sortLabel = sort.label;
  } else {
    out.sort((a, b) => b[1] - a[1]);
    res.sortLabel = scores ? "Best match first" : "Biggest first";
  }
  res.results = out.map(r => r[0]);
  if (scores && res.results.length) {
    const top = scores.get(ix.bySym.get(res.results[0].symbol)) || 0;
    const second = res.results[1] ? (scores.get(ix.bySym.get(res.results[1].symbol)) || 0) : 0;
    res.strong = top >= 300 || (top >= 180 && top > second * 1.4) || res.results.length === 1;
  }
  if (res.results.length && res.didYouMean && scores && [...scores.values()].some(v => v >= 100)) res.didYouMean = null;
  // Nothing in the open tab: say where it is ("1 match in ETFs").
  if (!res.results.length && keep && !opts._inner) {
    const all = search(query, list, { ...opts, filter: opts.elsewhereFilter || null, _inner: true });
    const by = {};
    for (const it of all.results) by[it.kind] = (by[it.kind] || 0) + 1;
    if (all.results.length) res.elsewhere = { by, top: all.results.slice(0, 3) };
  }
  res.ms = Math.round((performance.now() - t0) * 10) / 10;
  return res;
}

/** Query text with the phrase behind one chip removed. */
export function removeChipFromQuery(query, chip) {
  if (chip?.add) return (norm(query) + " " + chip.add).trim();
  if (!chip?.phrase) return "";
  const qn = norm(query);
  return qn.replace(chip.phrase, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Recent searches (this browser only).
const RECENT_KEY = "ss.search.recent.v1";
export function recentSearches() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").slice(0, 6); } catch { return []; }
}
export function rememberSearch(q) {
  const s = String(q || "").trim();
  if (s.length < 2 || s.length > 80) return;
  try {
    const list = recentSearches().filter(x => x.toLowerCase() !== s.toLowerCase());
    list.unshift(s);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 6)));
  } catch {}
}
export function forgetSearches() { try { localStorage.removeItem(RECENT_KEY); } catch {} }

/** "ETF" / "MF" when the words ask for that kind of instrument, else null. */
export function queryKind(query) {
  const qn = norm(query);
  return qn ? understand(qn).kind : null;
}
