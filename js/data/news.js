// =============================================================================
// NEWS & SENTIMENT — /api/news (handlers/news.py) reads ~16 Indian market RSS
// feeds server-side, CDN-cached, and returns a few hundred recent headlines
// with any Saathi take already generated. If it is down, the old path below
// (6 feeds through rss2json.com, ~10 items each) still fills the page.
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
// Accepts both spellings: the keyword scorer says bull/bear, the Saathi take
// says bullish/bearish. Only the short ones used to match, so a bearish take
// showed a red pill reading "Neutral".
export function labelSentiment(s) {
  return s === "bull" || s === "bullish" ? "Bullish" : s === "bear" || s === "bearish" ? "Bearish" : "Neutral";
}

// Every outbound news link carries our UTM tags so publishers see the visit
// came from us. A publisher's own tag in its feed links (Business Today puts
// utm_source=rssfeed on all of them) is replaced; ours is never added twice.
// Works with or without a query string or #fragment, and returns non-http
// values ("#") untouched.
export function withUtm(url) {
  if (!url || !/^https?:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    if (u.searchParams.get("utm_source") === "stocksaathi.co.in") return url;
    u.searchParams.set("utm_source", "stocksaathi.co.in");
    u.searchParams.set("utm_medium", "referral");
    return u.toString();
  } catch { return url; }
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

// Our UTM tags removed again: links handed to the server for reading the
// article must not show up in the publisher's stats as visits we sent.
export function withoutUtm(url) {
  if (!url || !/^https?:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    if (u.searchParams.get("utm_source") !== "stocksaathi.co.in") return url;
    u.searchParams.delete("utm_source");
    u.searchParams.delete("utm_medium");
    return u.toString();
  } catch { return url; }
}

// The same story as reported by other publishers in `items`: headlines that
// share enough distinctive words, from a different source, published within
// two days. Up to `max`, best match first, one per publisher.
const STORY_STOP = new Set(("the a an and or of to in on for with at by from as is are was were be been it its this that these those " +
  "after before over under into amid says said say will may can could would should has have had not no new now up down " +
  "india indian indias stock stocks share shares market markets price prices today week year crore lakh rs per cent percent " +
  "q1 q2 q3 q4 fy26 fy27 results result news check here what why how all more than about against").split(" "));
function storyWords(h) {
  return new Set(String(h || "").toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !STORY_STOP.has(w)));
}
export function findSameStory(item, items, max = 4) {
  const mine = storyWords(item.headline);
  if (mine.size < 2) return [];
  const scored = [];
  for (const o of items) {
    if (o === item || o.source === item.source || !o.url || o.url === "#") continue;
    if (Math.abs((o.ts || 0) - (item.ts || 0)) > 48 * 3_600_000) continue;
    const theirs = storyWords(o.headline);
    let shared = 0;
    for (const w of mine) if (theirs.has(w)) shared++;
    const score = shared / Math.min(mine.size, theirs.size || 1);
    if (shared >= 3 && score >= 0.4) scored.push({ o, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = [], seenSrc = new Set();
  for (const { o } of scored) {
    if (seenSrc.has(o.source)) continue;
    seenSrc.add(o.source);
    out.push(o);
    if (out.length >= max) break;
  }
  return out;
}

// Cache feed results briefly so navigating doesn't re-hammer RSS. One slot
// per language, because /api/news attaches that language's Saathi takes.
const _cache = new Map();   // "<lang>:full" / "<lang>:small" -> { ts, items }
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
      .then(r => { clearTimeout(t); return r.ok ? r.json() : r.text().then(() => null); })
      .then(j => {
        if (!j || j.status !== "ok" || !Array.isArray(j.items)) { resolve([]); return; }
        const items = j.items.map((it, i) => toItem({
          headline: stripHtml(it.title || ""),
          summary: stripHtml(it.description || it.content || "").slice(0, 280),
          source,
          url: it.link,
          ts: it.pubDate ? new Date(it.pubDate).getTime() : Date.now(),
          thumbnail: it.thumbnail || (it.enclosure?.link) || null,
          author: it.author || null,
        }, i)).filter(x => x.headline);
        resolve(items);
      })
      .catch(() => { clearTimeout(t); resolve([]); });
  });
}

function toItem({ headline, summary, source, url, ts, thumbnail, author = null, take = null }, i) {
  const fullText = headline + " " + summary;
  return {
    id: `${source}_${i}_${ts}`,
    headline,
    summary,
    source,
    url: withUtm(url || "#"),
    ts,
    hoursAgo: Math.round((Date.now() - ts) / 3_600_000),
    symbols: inferSymbols(fullText),
    sentiment: scoreSentiment(fullText),
    body: summary,
    thumbnail: thumbnail || null,
    author,
    take,   // { sentiment, tldr } when a Saathi take already exists, else null
  };
}

async function fetchServerNews(lang, force, small) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const qs = [lang === "hi" ? "lang=hi" : "", small ? "n=60" : ""].filter(Boolean).join("&");
    const r = await fetch("/api/news" + (qs ? "?" + qs : ""), {
      signal: ctrl.signal,
      // Refresh skips the browser's 2-minute copy; the CDN copy (≤10 min)
      // still answers, so the feeds aren't re-read per click.
      cache: force ? "no-cache" : "default",
    });
    // Always read the body, even on an error: Chrome keeps an unread
    // response open, which held the page "busy" forever.
    const text = await r.text();
    if (!r.ok) return [];
    const j = JSON.parse(text);
    if (!j?.ok || !Array.isArray(j.items)) return [];
    return j.items.map((it, i) => toItem({
      headline: it.h, summary: it.s || "", source: it.src, url: it.u,
      ts: it.ts, thumbnail: it.img, take: it.take || null,
    }, i)).filter(x => x.headline);
  } catch { return []; }
  finally { clearTimeout(t); }
}

/**
 * Return a list of news items, most-recent first, deduplicated by headline.
 * Falls back to a minimal curated set if all feeds fail.
 *   lang:  "hi" to get Hinglish Saathi takes attached (News page only).
 *   force: skip the in-memory and browser caches (Refresh button).
 */
export async function getNews({ limit = 40, filterSymbols = null, lang = "", force = false } = {}) {
  // A short unfiltered list (coach panel, portfolio card) only needs the
  // newest 60, ~12 KB instead of the full ~190 KB. A full list in memory
  // serves either kind of call.
  const small = limit <= 60 && !filterSymbols?.length;
  const hot = _cache.get(lang + ":full") || (small ? _cache.get(lang + ":small") : null);
  if (!force && hot && Date.now() - hot.ts < CACHE_TTL_MS && hot.items.length) {
    return applyFilter(hot.items, filterSymbols, limit);
  }
  let items = await fetchServerNews(lang, force, small);
  if (!items.length) items = (await Promise.all(FEEDS.map(fetchOneFeed))).flat();
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
  _cache.set(lang + (small ? ":small" : ":full"), { ts: Date.now(), items: out });
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
