// =============================================================================
// NEWS & SENTIMENT — Real RSS feeds via rss2json.com (free, CORS-enabled).
// Sources: Economic Times, LiveMint, Business Standard, BusinessLine, CNBC-TV18.
// Sentiment is a keyword scorer.
// =============================================================================

const RSS2JSON = "https://api.rss2json.com/v1/api.json?rss_url=";
const FETCH_TIMEOUT_MS = 7_000;

// Moneycontrol's RSS (marketsnews.xml, business.xml) started refusing automated
// fetches in Sept 2026 — 503 direct, 422 through rss2json — so every page load
// paid two failed requests for nothing. Replaced with two market feeds that
// return fresh items through rss2json (checked 2026-09-30).
const FEEDS = [
  { url: "https://www.thehindubusinessline.com/markets/stock-markets/feeder/default.rss", source: "BusinessLine" },
  { url: "https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml", source: "CNBC-TV18" },
  { url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", source: "Economic Times" },
  { url: "https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms", source: "Economic Times" },
  { url: "https://www.livemint.com/rss/markets", source: "LiveMint" },
  { url: "https://www.business-standard.com/rss/markets-106.rss", source: "Business Standard" },
];

const POS_WORDS = ["beat","beats","gain","gains","growth","grows","up","rally","rallies","surge","surges","breakout","record","high","highs","bullish","outperform","strong","robust","accelerate","optimistic","boom","rebound","expansion","positive","upgrade","inflow","inflows","firm","recover","soars","jumps","climb"];
const NEG_WORDS = ["miss","misses","loss","losses","decline","declines","fall","falls","drop","drops","selloff","bearish","underperform","weak","slowdown","pessimistic","crash","plunge","recession","negative","downgrade","outflow","outflows","hit","warning","concern","concerns","risk","slumps","tumbles","slides"];

export function scoreSentiment(text) {
  const t = String(text || "").toLowerCase();
  let pos = 0, neg = 0;
  for (const w of POS_WORDS) if (t.includes(w)) pos++;
  for (const w of NEG_WORDS) if (t.includes(w)) neg++;
  if (pos >= neg + 2) return "bull";
  if (neg >= pos + 2) return "bear";
  return "neutral";
}
export function labelSentiment(s) {
  return s === "bull" ? "Bullish" : s === "bear" ? "Bearish" : "Neutral";
}
export function fmtRelativeTime(ms) {
  const diff = Math.max(0, Date.now() - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// Cache feed results briefly so navigating doesn't re-hammer RSS
const _cache = { ts: 0, items: [] };
const CACHE_TTL_MS = 90_000;

/**
 * Match news items to known NSE symbols by looking for the symbol string
 * or common company names in the headline/summary.
 */
const SYMBOL_HINTS = {
  RELIANCE: ["reliance", " ril "],
  TCS: ["tcs", "tata consultancy"],
  HDFCBANK: ["hdfc bank"],
  INFY: ["infosys", " infy "],
  ICICIBANK: ["icici bank"],
  BHARTIARTL: ["bharti airtel", "airtel"],
  SBIN: ["sbi", "state bank"],
  ITC: [" itc "],
  LT: ["larsen", "l&t"],
  HINDUNILVR: ["hindustan unilever", "hul "],
  AXISBANK: ["axis bank"],
  KOTAKBANK: ["kotak"],
  BAJFINANCE: ["bajaj finance"],
  MARUTI: ["maruti"],
  TMPV: ["tata motors", "tmpv", "jaguar land rover", "jlr"],
  TMCV: ["tata motors commercial", "tmcv"],
  TATASTEEL: ["tata steel"],
  JSWSTEEL: ["jsw steel"],
  HINDALCO: ["hindalco"],
  COALINDIA: ["coal india"],
  ONGC: ["ongc"],
  NTPC: ["ntpc"],
  POWERGRID: ["power grid"],
  SUNPHARMA: ["sun pharma"],
  DRREDDY: ["dr reddy", "dr. reddy"],
  CIPLA: ["cipla"],
  NESTLEIND: ["nestle india", "nestlé"],
  ASIANPAINT: ["asian paints"],
  TITAN: ["titan company"],
  ULTRACEMCO: ["ultratech"],
  ADANIENT: ["adani enterprises"],
  ADANIPORTS: ["adani ports"],
  ETERNAL: ["eternal", "zomato"],
  PAYTM: ["paytm"],
  NYKAA: ["nykaa"],
  DMART: ["dmart", "avenue supermarts"],
  HCLTECH: ["hcl tech"],
  WIPRO: ["wipro"],
  TECHM: ["tech mahindra"],
  "BAJAJ-AUTO": ["bajaj auto"],
  EICHERMOT: ["eicher"],
  "M&M": ["mahindra & mahindra"],
  IRCTC: ["irctc"],
};

function inferSymbols(text) {
  const t = String(text || "").toLowerCase();
  const found = [];
  for (const [sym, hints] of Object.entries(SYMBOL_HINTS)) {
    if (hints.some(h => t.includes(h))) found.push(sym);
  }
  return found;
}

function stripHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchOneFeed({ url, source }) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    fetch(RSS2JSON + encodeURIComponent(url), { signal: ctrl.signal })
      .then(r => { clearTimeout(t); return r.ok ? r.json() : null; })
      .then(j => {
        if (!j || j.status !== "ok" || !Array.isArray(j.items)) { resolve([]); return; }
        const items = j.items.slice(0, 8).map((it, i) => {
          const headline = stripHtml(it.title || "");
          const summary = stripHtml(it.description || it.content || "").slice(0, 280);
          const ts = it.pubDate ? new Date(it.pubDate).getTime() : Date.now();
          const fullText = headline + " " + summary;
          return {
            id: `${source}_${i}_${ts}`,
            headline,
            summary,
            source,
            url: it.link || "#",
            ts,
            hoursAgo: Math.round((Date.now() - ts) / 3_600_000),
            symbols: inferSymbols(fullText),
            sentiment: scoreSentiment(fullText),
            body: summary,
            thumbnail: it.thumbnail || (it.enclosure?.link) || null,
            author: it.author || null,
          };
        }).filter(x => x.headline);
        resolve(items);
      })
      .catch(() => { clearTimeout(t); resolve([]); });
  });
}

/**
 * Return a list of news items, most-recent first, deduplicated by headline.
 * Falls back to a minimal curated set if all feeds fail.
 */
export async function getNews({ limit = 40, filterSymbols = null } = {}) {
  // Hot cache
  if (Date.now() - _cache.ts < CACHE_TTL_MS && _cache.items.length) {
    return applyFilter(_cache.items, filterSymbols, limit);
  }
  const feedResults = await Promise.all(FEEDS.map(fetchOneFeed));
  let items = feedResults.flat();
  if (!items.length) items = FALLBACK_ITEMS();
  // Dedupe by headline
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = it.headline.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  _cache.ts = Date.now();
  _cache.items = out;
  return applyFilter(out, filterSymbols, limit);
}

function applyFilter(items, filterSymbols, limit) {
  if (filterSymbols?.length) {
    const syms = new Set(filterSymbols);
    items = items.filter(it => it.symbols?.some(s => syms.has(s)));
  }
  return items.slice(0, limit);
}

function FALLBACK_ITEMS() {
  const now = Date.now();
  return [
    { id: "f1", headline: "Indian markets trade range-bound as IT and banking swing", summary: "Nifty and Sensex moved in a narrow band through the session.", source: "Offline cache", url: "#", ts: now - 3600_000, hoursAgo: 1, symbols: [], sentiment: "neutral", body: "" },
    { id: "f2", headline: "FII flows turn positive for the week", summary: "Foreign investors were net buyers across sectors.", source: "Offline cache", url: "#", ts: now - 7200_000, hoursAgo: 2, symbols: [], sentiment: "bull", body: "" },
  ];
}
