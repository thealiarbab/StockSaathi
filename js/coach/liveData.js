// =============================================================================
// LIVE DATA — the layer that makes the coach feel "alive".
// Detects price queries in natural language, fetches real quotes (stocks via
// our Yahoo proxy, crypto via CoinGecko), and returns a ready-to-send reply.
// =============================================================================

import { getInstrument, STOCKS } from "../data/universe.js";
import { getQuote } from "../data/marketData.js";

// -----------------------------------------------------------------------------
// Crypto ID map — CoinGecko IDs for common tickers
// -----------------------------------------------------------------------------
const CRYPTO_IDS = {
  btc: "bitcoin", bitcoin: "bitcoin",
  eth: "ethereum", ethereum: "ethereum", ether: "ethereum",
  bnb: "binancecoin", binance: "binancecoin",
  sol: "solana", solana: "solana",
  xrp: "ripple", ripple: "ripple",
  ada: "cardano", cardano: "cardano",
  doge: "dogecoin", dogecoin: "dogecoin",
  shib: "shiba-inu", shiba: "shiba-inu",
  dot: "polkadot", polkadot: "polkadot",
  matic: "matic-network", polygon: "matic-network",
  avax: "avalanche-2", avalanche: "avalanche-2",
  ltc: "litecoin", litecoin: "litecoin",
  trx: "tron", tron: "tron",
  link: "chainlink", chainlink: "chainlink",
  atom: "cosmos", cosmos: "cosmos",
  uni: "uniswap", uniswap: "uniswap",
  near: "near",
  tia: "celestia",
};

// -----------------------------------------------------------------------------
// Stock aliases — map friendly names to NSE tickers in our universe
// -----------------------------------------------------------------------------
const STOCK_ALIASES_BASE = {
  reliance: "RELIANCE", ril: "RELIANCE", jio: "RELIANCE",
  tcs: "TCS", "tata consultancy": "TCS",
  infosys: "INFY", infy: "INFY",
  hdfc: "HDFCBANK", "hdfc bank": "HDFCBANK", hdfcbank: "HDFCBANK",
  icici: "ICICIBANK", "icici bank": "ICICIBANK", icicibank: "ICICIBANK",
  sbi: "SBIN", "state bank": "SBIN",
  airtel: "BHARTIARTL", bharti: "BHARTIARTL",
  itc: "ITC",
  "l&t": "LT", larsen: "LT",
  hul: "HINDUNILVR", unilever: "HINDUNILVR",
  axis: "AXISBANK", "axis bank": "AXISBANK",
  kotak: "KOTAKBANK", "kotak bank": "KOTAKBANK",
  maruti: "MARUTI", "maruti suzuki": "MARUTI",
  "tata motors": "TMPV", tatamotors: "TMPV", tmpv: "TMPV", tmcv: "TMCV",
  "tata steel": "TATASTEEL", tatasteel: "TATASTEEL",
  "jsw steel": "JSWSTEEL",
  hindalco: "HINDALCO",
  coal: "COALINDIA", coalindia: "COALINDIA",
  ongc: "ONGC",
  ntpc: "NTPC",
  powergrid: "POWERGRID", "power grid": "POWERGRID",
  nestle: "NESTLEIND", "nestle india": "NESTLEIND",
  britannia: "BRITANNIA",
  dabur: "DABUR",
  titan: "TITAN",
  "asian paints": "ASIANPAINT", asianpaint: "ASIANPAINT",
  "sun pharma": "SUNPHARMA", sunpharma: "SUNPHARMA",
  "dr reddy": "DRREDDY", drreddy: "DRREDDY",
  cipla: "CIPLA",
  divis: "DIVISLAB", "divi's": "DIVISLAB",
  ultratech: "ULTRACEMCO", ultracemco: "ULTRACEMCO",
  grasim: "GRASIM",
  zomato: "ETERNAL", eternal: "ETERNAL",
  paytm: "PAYTM",
  nykaa: "NYKAA",
  policybazaar: "POLICYBZR",
  dmart: "DMART",
  adani: "ADANIENT", "adani enterprises": "ADANIENT",
  "adani ports": "ADANIPORTS", adaniports: "ADANIPORTS",
  irctc: "IRCTC",
  hcl: "HCLTECH", hcltech: "HCLTECH",
  wipro: "WIPRO",
  "tech mahindra": "TECHM", techm: "TECHM",
  ltimindtree: "LTIM", ltim: "LTIM",
  "bajaj finance": "BAJFINANCE", bajfinance: "BAJFINANCE",
  "hdfc life": "HDFCLIFE", hdfclife: "HDFCLIFE",
  "sbi life": "SBILIFE", sbilife: "SBILIFE",
  "bajaj auto": "BAJAJ-AUTO", bajajauto: "BAJAJ-AUTO",
  eicher: "EICHERMOT", "royal enfield": "EICHERMOT",
  "mahindra": "M&M", "m&m": "M&M",
};

// Build full alias map: include the NSE ticker itself (uppercase + lowercase)
const STOCK_ALIASES = { ...STOCK_ALIASES_BASE };
for (const s of STOCKS) {
  STOCK_ALIASES[s.symbol.toLowerCase()] = s.symbol;
  STOCK_ALIASES[s.name.toLowerCase()] = s.symbol;
}

// -----------------------------------------------------------------------------
// Detection — does the user's text look like a price/quote query?
// -----------------------------------------------------------------------------

const PRICE_WORDS = /\b(price|rate|quote|quotes|value|worth|trading|now|today|ltp|current|cmp)\b/i;

export function detectPriceQuery(text) {
  if (!text || typeof text !== "string") return null;
  const t = text.trim().toLowerCase();
  if (!t) return null;

  // Fast path: is it just a known ticker/crypto alone? ("btc?", "tcs", "reliance")
  const bareMatch = t.match(/^[@#$]?([a-z0-9&\-. ]{2,30})\??\.?!?$/);
  if (bareMatch) {
    const q = bareMatch[1].trim();
    const hit = resolveSymbol(q);
    if (hit) return hit;
  }

  // Does the message mention prices at all?
  const mentionsPrice = PRICE_WORDS.test(t);

  // Scan every word / 2-word combo against our maps
  const words = t.replace(/[^a-z0-9&\-. ]/g, " ").split(/\s+/).filter(Boolean);
  // 2-word
  for (let i = 0; i < words.length - 1; i++) {
    const two = `${words[i]} ${words[i + 1]}`;
    const hit = resolveSymbol(two);
    if (hit && (mentionsPrice || isStrongSignal(t))) return hit;
  }
  // 1-word
  for (const w of words) {
    const hit = resolveSymbol(w);
    if (hit && (mentionsPrice || isStrongSignal(t))) return hit;
  }

  return null;
}

// "Strong signal" = phrases that clearly ask for a quote even without 'price' word.
const STRONG_PATTERNS = [
  /\bhow much (is|are)\b/i,
  /\bwhat(?:'s| is) .*\b(at|now|today|trading)\b/i,
  /\b(show|tell) me .* (price|rate|quote)\b/i,
  /\bltp\b/i,
  /\bcurrent price\b/i,
  /\bwhat(?:'s| is).*\?$/i,
];
function isStrongSignal(t) {
  return STRONG_PATTERNS.some(p => p.test(t));
}

function resolveSymbol(q) {
  const lower = q.toLowerCase().trim().replace(/[^a-z0-9 &\-.]/g, "");
  if (CRYPTO_IDS[lower]) return { kind: "crypto", id: CRYPTO_IDS[lower], label: q.toUpperCase() };
  if (STOCK_ALIASES[lower]) return { kind: "stock", symbol: STOCK_ALIASES[lower] };
  // Direct NSE-symbol check (upper)
  const upper = lower.toUpperCase().replace(/\s+/g, "");
  if (getInstrument(upper)) return { kind: "stock", symbol: upper };
  return null;
}

// -----------------------------------------------------------------------------
// Fetchers
// -----------------------------------------------------------------------------

export async function fetchCryptoPrice(coinId) {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=inr,usd&include_24hr_change=true&include_market_cap=true`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    return data[coinId] || null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Formatted replies
// -----------------------------------------------------------------------------

function fmtINR(v) {
  if (v == null) return "—";
  if (v >= 1e7) return "₹" + (v / 1e7).toFixed(2) + " Cr";
  if (v >= 1e5) return "₹" + (v / 1e5).toFixed(2) + " L";
  if (v >= 1e3) return "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  return "₹" + v.toFixed(2);
}
function fmtUSD(v) {
  if (v == null) return "—";
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: v < 1 ? 4 : 0 });
}
function fmtPct(v) {
  if (v == null) return "";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

export async function answerPriceQuery(text) {
  const det = detectPriceQuery(text);
  if (!det) return null;

  if (det.kind === "crypto") {
    const p = await fetchCryptoPrice(det.id);
    if (!p) return null;
    const inr = fmtINR(p.inr);
    const usd = fmtUSD(p.usd);
    const ch = fmtPct(p.inr_24h_change);
    const mcap = p.inr_market_cap ? ` Market cap: ${fmtINR(p.inr_market_cap)}.` : "";
    const name = capitalize(det.id.replace(/-/g, " "));
    const parts = [
      `**${name}** is at ${inr} (~${usd}) right now. ${ch ? `24h: ${ch}.` : ""}${mcap}`.trim(),
    ];
    parts.push(
      `Heads up on crypto in India: 30% flat tax on gains + 1% TDS on every trade since 2022 — much heavier than equity. Drawdowns of 70-80% have happened more than once. As a tiny satellite (<5%) it's fine to learn with; as a core holding it's pretty hostile to compounding.`
    );
    return parts.join("\n\n");
  }

  if (det.kind === "stock") {
    const q = await getQuote(det.symbol);
    const inst = getInstrument(det.symbol);
    if (!q || !inst) return null;
    const price = (q.pricePaise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
    const chPct = q.changePct * 100;
    const chStr = fmtPct(chPct);
    const live = q.source === "yahoo" || q.source === "finnhub";
    const peNum = Number(inst.pe);
    const peStr = Number.isFinite(peNum) && peNum > 0 ? ` P/E is ${peNum.toLocaleString("en-IN", { maximumFractionDigits: peNum >= 100 ? 0 : 1 })}.` : "";
    const tail = live ? "Live from Yahoo Finance." : "Cached price (live feed not reachable).";
    return [
      `**${inst.name}** (${det.symbol}) — ₹${price}, ${chStr} today. Sector: ${inst.sector}.${peStr}`,
      tail,
      `I won't tell you whether to buy or sell. If you want to pressure-test the case — earnings trajectory, valuation vs sector, drawdown tolerance, portfolio fit — I'll go as deep as you want.`,
    ].join("\n\n");
  }

  return null;
}

/**
 * Shape a "price context" block to inject into the LLM system prompt
 * when a price query is detected. LLM gets real numbers instead of guessing.
 */
export async function buildPriceContext(text) {
  const det = detectPriceQuery(text);
  if (!det) return null;
  if (det.kind === "crypto") {
    const p = await fetchCryptoPrice(det.id);
    if (!p) return null;
    return {
      kind: "crypto",
      summary: `${capitalize(det.id)}: INR ₹${Math.round(p.inr).toLocaleString("en-IN")}, USD $${Math.round(p.usd).toLocaleString("en-US")}, 24h change ${p.inr_24h_change?.toFixed(2)}%`,
    };
  }
  if (det.kind === "stock") {
    const q = await getQuote(det.symbol);
    const inst = getInstrument(det.symbol);
    if (!q || !inst) return null;
    return {
      kind: "stock",
      summary: `${inst.name} (${det.symbol}): ₹${(q.pricePaise/100).toFixed(2)}, ${(q.changePct*100).toFixed(2)}% today, sector ${inst.sector}, P/E ${inst.pe || "n/a"}, source ${q.source}`,
    };
  }
  return null;
}
