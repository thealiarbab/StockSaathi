// =============================================================================
// AGENT — Real LLM with tool-use. Groq-first (free + fast), BYO-key fallback.
//
// Groq Llama 3.3 70B: 500+ tokens/sec, free tier generous enough for 100-user
// pitch demos, OpenAI-compatible tool-use API. User's own key (if set in
// Settings) goes direct to Groq; otherwise we go through /api/chat which the
// backend proxies using GROQ_API_KEY env var.
// =============================================================================

import { getInstrument, getAllInstruments, STOCKS, MUTUAL_FUNDS } from "../data/universe.js";
import { getQuote } from "../data/marketData.js";
import { getNews } from "../data/news.js";
import { getState, getPortfolioValue } from "../state.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const BACKEND_URL = "/api/chat";
// MODEL here is a client-side hint only — /api/chat overrides it with the
// actual Gemini model based on the profile. Kept short so it still works
// if someone sets their own Groq key (legacy "bring your own key" path).
const MODEL = "llama-3.3-70b-versatile";
// Keep responses tight — Gemini thinking models spend tokens on internal
// reasoning, so a smaller budget = less thinking = faster UX without losing
// response quality (the visible reply is usually 200–400 tokens anyway).
const MAX_TOKENS = 512;
const MAX_TOOL_LOOPS = 5;

// -----------------------------------------------------------------------------
// Tools — OpenAI function-calling schema (Groq/OpenAI format)
// -----------------------------------------------------------------------------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_stock_price",
      description:
        "Fetch the current LIVE price for an Indian NSE-listed stock. Returns price, day change %, sector, P/E, day high/low. Use whenever the user asks about ANY specific Indian stock by ticker OR by company name (e.g. 'reliance', 'tcs', 'hdfc bank', 'adani ports').",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "NSE ticker (RELIANCE, TCS, INFY, HDFCBANK) OR a common company name — both work.",
          },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_crypto_price",
      description:
        "Fetch the current LIVE price of a cryptocurrency. Returns INR, USD, 24h change %, market cap. Use when the user asks about ANY crypto — bitcoin, BTC, eth, ethereum, solana, dogecoin, shiba, etc.",
      parameters: {
        type: "object",
        properties: {
          coin: {
            type: "string",
            description: "Coin name or ticker. Accepts: bitcoin, btc, ethereum, eth, solana, sol, dogecoin, doge, etc.",
          },
        },
        required: ["coin"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_stocks",
      description:
        "Search the Indian NSE universe by partial name, sector, or ticker. Use when the user is exploring and doesn't name a specific ticker (e.g. 'show me IT stocks', 'find pharma companies', 'anything related to banking').",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free text: company name, sector, or partial ticker." },
          limit: { type: "number", description: "Max results (default 8, max 20)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_market_news",
      description:
        "Fetch the latest Indian market news headlines with sentiment (bullish/bearish/neutral). Use when the user asks about current market mood, sector news, or what's happening today.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max headlines (default 5, max 12)." },
          symbols: {
            type: "array",
            items: { type: "string" },
            description: "Optional — filter to headlines mentioning these NSE tickers.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_user_portfolio",
      description:
        "Get the user's current virtual portfolio: cash, holdings (with live values + P&L), return %. Use for 'my portfolio', 'my holdings', 'how am I doing', 'what do I own'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_trade_history",
      description:
        "The user's actual BUY/SELL transaction history, newest first, with realised profit/loss per closed position. Use for ANY question about what they have DONE rather than what they currently hold: 'show me all my trades', 'my recent activity', 'what did I buy last week', 'my best trade', 'did I panic sell', 'how many trades have I made'. get_user_portfolio does NOT contain this.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max trades to return (default 20, max 50)." },
          symbol: { type: "string", description: "Optional — only trades in this NSE ticker." },
        },
      },
    },
  },
];

// -----------------------------------------------------------------------------
// Tool executors (client-side)
// -----------------------------------------------------------------------------
async function execGetStockPrice(input) {
  const raw = String(input.symbol || "").trim();
  const sym = resolveSymbolFuzzy(raw);
  if (!sym) return { ok: false, error: `No NSE stock matching "${raw}". Try search_stocks.` };
  try {
    const q = await getQuote(sym);
    const inst = getInstrument(sym);
    if (!q || !inst) return { ok: false, error: `No quote for ${sym}.` };
    return {
      ok: true,
      symbol: sym,
      name: inst.name,
      sector: inst.sector,
      price_inr: +(q.pricePaise / 100).toFixed(2),
      prev_close_inr: +(q.prevClosePaise / 100).toFixed(2),
      day_change_pct: +(q.changePct * 100).toFixed(2),
      day_high_inr: +(q.high / 100).toFixed(2),
      day_low_inr: +(q.low / 100).toFixed(2),
      pe_ratio: inst.pe,
      pb_ratio: inst.pb,
      market_cap: inst.marketCap,
      risk_tier: inst.risk,
      data_source: q.source,
      is_live: !q.stale,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function execGetCryptoPrice(input) {
  const coin = String(input.coin || "").toLowerCase().trim();
  const id = resolveCryptoId(coin);
  if (!id) return { ok: false, error: `Unknown coin "${coin}". Try bitcoin, ethereum, solana, dogecoin.` };
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=inr,usd&include_24hr_change=true&include_market_cap=true`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, error: `CoinGecko ${res.status}` };
    const data = await res.json();
    const p = data[id];
    if (!p) return { ok: false, error: `No data for ${id}` };
    return {
      ok: true,
      coin: id,
      price_inr: p.inr,
      price_usd: p.usd,
      change_24h_pct: p.inr_24h_change != null ? +p.inr_24h_change.toFixed(2) : null,
      market_cap_inr: p.inr_market_cap,
      note: "India: crypto gains taxed at 30% + 1% TDS per trade since 2022.",
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function execSearchStocks(input) {
  const q = String(input.query || "").toLowerCase().trim();
  const limit = Math.min(input.limit || 8, 20);
  if (!q) return { ok: false, error: "Empty query." };
  // getAllInstruments() is the full merged universe (~2,200 NSE rows +
  // ~14,000 AMFI schemes). STOCKS/MUTUAL_FUNDS are only the ~100 curated
  // FEATURED_SYMBOLS plus 10 placeholder funds, so searching those made
  // "show me banking stocks" miss almost every bank on the exchange.
  let all = [];
  try { all = getAllInstruments() || []; } catch (_) { all = []; }
  if (!all.length) all = [...STOCKS, ...MUTUAL_FUNDS];
  const matches = all
    .map(s => {
      let score = 0;
      const name = s.name.toLowerCase();
      const sector = (s.sector || "").toLowerCase();
      const sym = s.symbol.toLowerCase();
      if (sym === q) score += 100;
      if (sym.includes(q)) score += 50;
      if (name.includes(q)) score += 30;
      if (sector.includes(q)) score += 20;
      if (name.split(/\s+/).some(w => w === q)) score += 15;
      return { s, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => ({ symbol: x.s.symbol, name: x.s.name, sector: x.s.sector, kind: x.s.kind, risk: x.s.risk }));
  return { ok: true, query: q, results: matches, count: matches.length };
}

async function execGetMarketNews(input) {
  try {
    const items = await getNews({
      limit: Math.min(input.limit || 5, 12),
      filterSymbols: input.symbols?.length ? input.symbols.map(s => s.toUpperCase()) : null,
    });
    return {
      ok: true,
      headlines: items.map(n => ({
        headline: n.headline, summary: n.summary, source: n.source,
        sentiment: n.sentiment, hours_ago: n.hoursAgo, url: n.url, symbols: n.symbols,
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function execGetUserPortfolio() {
  const state = getState();
  if (!state.isAuthed) return { ok: false, error: "User not logged in." };
  const holdings = [];
  for (const [sym, h] of Object.entries(state.holdings || {})) {
    const inst = getInstrument(sym);
    if (!inst) continue;
    try {
      const q = await getQuote(sym);
      const curPx = q ? q.pricePaise : h.avgCostPaise;
      holdings.push({
        symbol: sym, name: inst.name, qty: h.qty,
        avg_cost_inr: +(h.avgCostPaise / 100).toFixed(2),
        current_price_inr: +(curPx / 100).toFixed(2),
        value_inr: +((h.qty * curPx) / 100).toFixed(2),
        pl_pct: +(((curPx - h.avgCostPaise) / h.avgCostPaise) * 100).toFixed(2),
      });
    } catch {}
  }
  const total = getPortfolioValue(state);
  const start = state.portfolio.startingCashPaise;

  // Sanity guard. A corrupted account (seeded/admin rows with qty in the
  // billions and a zero average cost) produced a portfolio worth more than
  // every market on earth, and the coach dutifully explained to the user
  // that those positions "were acquired at no cost". Hand the model an
  // explicit flag so it reports a data problem instead of a fortune.
  const suspect = holdings.filter(h =>
    !Number.isFinite(h.qty) || h.qty > 1e7 ||
    !Number.isFinite(h.avg_cost_inr) || h.avg_cost_inr <= 0
  ).map(h => h.symbol);
  const totalInr = total / 100;
  const absurdTotal = !Number.isFinite(totalInr) || Math.abs(totalInr) > 1e11;

  const out = {
    ok: true,
    cash_inr: +(state.portfolio.cashPaise / 100).toFixed(2),
    total_value_inr: +totalInr.toFixed(2),
    return_pct: +(((total - start) / start) * 100).toFixed(2),
    holdings, holdings_count: holdings.length,
    trade_count: state.transactions.length,
  };
  if (suspect.length || absurdTotal) {
    out.data_warning =
      "These figures are corrupt, not real performance. Tell the user their portfolio data looks broken and to contact support. Do NOT present these numbers as their actual holdings, and do NOT explain them as free or zero-cost shares." +
      (suspect.length ? ` Affected: ${suspect.join(", ")}.` : "");
  }
  return out;
}

/**
 * Actual trade history. This tool exists because its absence produced the
 * single worst failure in the logs.
 *
 * haldenbeet, 2026-04-22, asked "Can u show me all the trades i have made?".
 * The coach had only get_user_portfolio — holdings, no transactions — so it
 * invented an entire trading record and stuck to it across four consecutive
 * turns: "You're at ₹1,04,230 total... 4 positions, biggest is RELIANCE at
 * ₹28k... best performer this week is INFY (+6.8%)", then "your best trade is
 * Reliance, up 18.5%", then "You haven't panic sold any stocks."
 *
 * Every figure was fabricated. The next day the coach pulled the real
 * portfolio: ₹1,00,201.90, two holdings — Vedanta and a gold fund. No
 * Reliance. No Infosys. The numbers it had recited were the placeholder
 * portfolio from the system prompt's own tone examples.
 *
 * Three other users asked variants of the same question. Giving the model a
 * real answer is the fix; telling it not to lie is only half of one.
 */
async function execGetTradeHistory(input) {
  const state = getState();
  if (!state.isAuthed) return { ok: false, error: "User not logged in." };
  const limit = Math.min(Math.max(1, Number(input?.limit) || 20), 50);
  const wantSym = input?.symbol ? resolveSymbolFuzzy(String(input.symbol)) : null;

  const all = Array.isArray(state.transactions) ? state.transactions : [];
  const rows = (wantSym ? all.filter(t => t.symbol === wantSym) : all)
    .slice()
    .sort((a, b) => b.ts - a.ts);

  if (!rows.length) {
    return {
      ok: true, trades: [], count: 0, total_trades_ever: all.length,
      note: wantSym
        ? `No trades in ${wantSym}.`
        : "This user has never placed a trade. Say exactly that — do not invent one.",
    };
  }

  // Running average cost per symbol, walked oldest-first, so a SELL can be
  // reported with the realised P&L it actually produced.
  const book = {};
  const realised = new Map();
  for (const t of rows.slice().reverse()) {
    const b = book[t.symbol] || { qty: 0, avg: 0 };
    if (t.side === "BUY") {
      const newQty = b.qty + t.qty;
      b.avg = newQty > 0 ? Math.round((b.avg * b.qty + t.pricePaise * t.qty) / newQty) : t.pricePaise;
      b.qty = newQty;
    } else {
      if (b.qty > 0) realised.set(t.id, Math.round((t.pricePaise - b.avg) * t.qty));
      b.qty = Math.max(0, b.qty - t.qty);
    }
    book[t.symbol] = b;
  }

  const trades = rows.slice(0, limit).map(t => {
    const inst = getInstrument(t.symbol);
    const pl = realised.get(t.id);
    return {
      date: new Date(t.ts).toISOString().slice(0, 10),
      symbol: t.symbol,
      name: inst?.name || t.symbol,
      side: t.side,
      qty: t.qty,
      price_inr: +(t.pricePaise / 100).toFixed(2),
      value_inr: +(t.valuePaise / 100).toFixed(2),
      realised_pl_inr: pl != null ? +(pl / 100).toFixed(2) : null,
      flags: Array.isArray(t.biasFlags)
        ? t.biasFlags.map(f => f?.bias).filter(Boolean)
        : [],
    };
  });

  return {
    ok: true,
    trades,
    count: trades.length,
    total_trades_ever: all.length,
    note: "realised_pl_inr is set only on SELLs that closed part of a position; null means the trade opened or added to one. `flags` carries any behavioural pattern the app recorded at trade time (e.g. panic_sell). Report only what is here.",
  };
}

const EXECUTORS = {
  get_stock_price: execGetStockPrice,
  get_trade_history: execGetTradeHistory,
  get_crypto_price: execGetCryptoPrice,
  search_stocks: execSearchStocks,
  get_market_news: execGetMarketNews,
  get_user_portfolio: execGetUserPortfolio,
};

// -----------------------------------------------------------------------------
// Fuzzy symbol resolution — let the LLM be sloppy with names
// -----------------------------------------------------------------------------
// Built LAZILY, not at module load. `STOCKS` is an `export let` that the
// universe loader reassigns once universeFull.json lands, and it only ever
// holds the ~100 FEATURED_SYMBOLS. At import time those are bare stubs whose
// `name` IS the symbol — so a map snapshotted here at module load contained
// zero real company names, and every name-based lookup ("orient electric",
// "bajaj finance") fell through to the 30-odd hardcoded aliases below and
// then failed with "No NSE stock matching". Build from getAllInstruments()
// (the full ~2,200-row merged universe) on first use, and drop the cache
// when the loader announces fresh rows.
let _nameMap = null;
try {
  window.addEventListener("ss:universe-loaded", () => { _nameMap = null; });
  window.addEventListener("ss:mf-universe-loaded", () => { _nameMap = null; });
} catch (_) {}

function nameToSymbol() {
  if (_nameMap) return _nameMap;
  const m = {};
  let rows = [];
  try { rows = getAllInstruments() || []; } catch (_) { rows = []; }
  if (!rows.length) rows = [...STOCKS, ...MUTUAL_FUNDS];
  for (const s of rows) {
    if (!s?.symbol) continue;
    m[s.symbol.toLowerCase()] = s.symbol;
    const name = String(s.name || "");
    if (!name || name === s.symbol) continue;
    m[name.toLowerCase()] = s.symbol;
    m[name.toLowerCase().replace(/\s+/g, "")] = s.symbol;
    // First word of name — only for equities, and never let a fund's
    // generic leading word ("gold", "index", "nifty") shadow a real ticker.
    if (s.kind === "MF") continue;
    const first = name.toLowerCase().split(/\s+/)[0];
    if (first.length >= 3 && !m[first]) m[first] = s.symbol;
  }
  Object.assign(m, {
    ril: "RELIANCE", jio: "RELIANCE",
    hdfc: "HDFCBANK", "hdfc bank": "HDFCBANK",
    icici: "ICICIBANK", "icici bank": "ICICIBANK",
    infy: "INFY", infosys: "INFY",
    sbi: "SBIN", "state bank": "SBIN",
    airtel: "BHARTIARTL", bharti: "BHARTIARTL",
    "l&t": "LT", lt: "LT", larsen: "LT",
    hul: "HINDUNILVR", "hindustan unilever": "HINDUNILVR",
    "tata motors": "TMPV", tmpv: "TMPV", tmcv: "TMCV",
    "tata steel": "TATASTEEL",
    nestle: "NESTLEIND",
    "sun pharma": "SUNPHARMA",
    "dr reddy": "DRREDDY",
    "asian paints": "ASIANPAINT",
    hcl: "HCLTECH", hcltech: "HCLTECH",
    "tech mahindra": "TECHM",
    kotak: "KOTAKBANK",
    axis: "AXISBANK",
    "bajaj finance": "BAJFINANCE",
    "bajaj auto": "BAJAJ-AUTO",
    eicher: "EICHERMOT",
    mahindra: "M&M", "m&m": "M&M",
    ultratech: "ULTRACEMCO",
    coal: "COALINDIA", "coal india": "COALINDIA",
    adani: "ADANIENT", "adani ports": "ADANIPORTS",
  });
  _nameMap = m;
  return m;
}

// `allowStub` controls what happens for an input that looks like a ticker but
// isn't in the universe. The TOOL executor wants the lenient behaviour (try
// the quote API anyway — the universe can lag the exchange). The ROUTING
// heuristic wants the strict one: getInstrument() never returns null, it
// synthesises a stub for any string, so a lenient resolve would match every
// word in every sentence.
function resolveSymbolFuzzy(input, { allowStub = true } = {}) {
  const s = String(input || "").toLowerCase().trim();
  if (!s) return null;
  const upper = String(input).toUpperCase().trim();
  const direct = getInstrument(upper);
  if (direct && !direct._stub) return upper;
  const m = nameToSymbol();
  if (m[s]) return m[s];
  const cleaned = s.replace(/\s+(ltd|limited|india|indian|corp|corporation|co)\b/g, "").trim();
  if (m[cleaned]) return m[cleaned];
  // Plausible-ticker fallback: no spaces, 2-12 chars, letter-led.
  if (allowStub && /^[A-Za-z][A-Za-z0-9&.\-]{1,11}$/.test(upper)) return upper;
  return null;
}

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
  near: "near", tia: "celestia",
};
function resolveCryptoId(q) {
  const clean = String(q).toLowerCase().trim().replace(/[^a-z0-9-]/g, "");
  if (CRYPTO_IDS[clean]) return CRYPTO_IDS[clean];
  if (clean.length >= 3) return clean;
  return null;
}

// -----------------------------------------------------------------------------
// Transport — client-direct OR via backend proxy
// -----------------------------------------------------------------------------
async function callLLM({ apiKey, system, messages, tools, profile = "fast" }) {
  // Convert chat history (role/content string) to OpenAI format
  const openaiMessages = [
    { role: "system", content: system },
    ...messages,
  ];
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0.5,
    messages: openaiMessages,
    tools,
    tool_choice: "auto",
    // Default profile is "fast" (Gemini Flash). Flash is ~3× faster than
    // Pro on conversational chat because it doesn't run deep chain-of-thought
    // on every message — and for a "hi, what's TCS at?" interaction Flash
    // is more than smart enough. Callers that need deep reasoning (deep
    // analysis, crash replay JSON) pass profile:"reasoning" explicitly.
    profile,
  };

  // If user has their own Groq key → direct call (fastest path)
  if (apiKey) {
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.warn("Groq direct HTTP", res.status);
        return null;
      }
      return await res.json();
    } catch (e) {
      console.warn("Groq direct failed:", e);
      return null;
    }
  }

  // Otherwise go through our backend proxy
  try {
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn("Backend /api/chat", res.status, txt);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn("Backend /api/chat failed:", e);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Main agent loop (OpenAI-style tool_calls)
// -----------------------------------------------------------------------------
export async function runAgent({ apiKey, system, messages, onStep, profile = "fast" }) {
  let loops = 0;
  const conv = messages.map(m => ({ ...m }));

  while (loops < MAX_TOOL_LOOPS) {
    loops++;
    const resp = await callLLM({ apiKey, system, messages: conv, tools: TOOLS, profile });
    if (!resp) {
      console.warn("LLM unreachable (attempt", loops, ")");
      return null;
    }
    if (resp.error) {
      console.warn("LLM error:", JSON.stringify(resp.error).slice(0, 200));
      return null;
    }
    const choice = resp.choices?.[0];
    if (!choice) {
      console.warn("LLM empty choices");
      return null;
    }
    const msg = choice.message || {};

    // Tool-use branch: Groq/OpenAI format has msg.tool_calls array
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const wantsTools = toolCalls.length > 0 &&
      (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call" || !msg.content);

    if (wantsTools) {
      onStep?.({ stepIndex: loops, action: "tool_calls", tools: toolCalls.map(tc => tc.function?.name) });

      // Append assistant tool-call turn as-is
      conv.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: toolCalls,
      });

      // Execute tools in parallel, collect results
      const results = await Promise.all(toolCalls.map(async (tc) => {
        const name = tc.function?.name || "";
        let args = {};
        const rawArgs = tc.function?.arguments ?? "{}";
        try {
          args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : (rawArgs || {});
        } catch (e) {
          args = {};
          console.warn("tool arg parse fail:", rawArgs);
        }
        const executor = EXECUTORS[name];
        let result;
        if (!executor) {
          result = { ok: false, error: `Unknown tool: ${name}. Available: ${Object.keys(EXECUTORS).join(", ")}` };
        } else {
          try { result = await executor(args); }
          catch (e) { result = { ok: false, error: String(e?.message || e) }; }
        }
        return {
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result).slice(0, 4000),   // cap large payloads
        };
      }));

      conv.push(...results);
      continue;
    }

    // Final text response — but sanitise first. Gemini 3 Flash Preview
    // sometimes narrates its tool-use in the content stream as literal text
    // like 'CALL search_stocks(query="...")' or '[Tool call: ...]' instead
    // of emitting a proper tool_calls JSON block. These strings MUST not
    // leak into the user-facing bubble — they're model-internal scaffolding.
    // We strip them wholesale; if the model hallucinated a result after
    // such a line we keep the prose around it (best-effort).
    const text = stripToolCallScaffolding(String(msg.content || "")).trim();
    return text || null;
  }

  console.warn("Agent: hit MAX_TOOL_LOOPS");
  return null;
}

export { TOOLS };

// -----------------------------------------------------------------------------
// Streaming chat — no tools, pipes tokens through as they arrive.
// Pairs with the /api/chat SSE passthrough. Caller provides onToken(delta)
// and gets each new chunk of assistant text as Gemini produces it. First
// token typically arrives in ~300ms, making the coach feel instantaneous
// even if total generation takes 1–2s.
//
// Returns the full assembled text at completion, or null on failure.
// Falls back cleanly — the caller should treat null as "use non-stream path".
// -----------------------------------------------------------------------------
export async function streamChat({ system, messages, profile = "chat", onToken, signal }) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0.5,
    messages: [
      { role: "system", content: system },
      ...messages,
    ],
    stream: true,
    profile,
  };
  let res;
  try {
    res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") return { aborted: true, text: "", raw: "" };
    console.warn("streamChat fetch:", e);
    return { error: e?.message || "network_error", text: "" };
  }
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    console.warn("streamChat http:", res.status, errText.slice(0, 200));
    return { error: `http_${res.status}`, text: "" };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  // Tracks how many characters of the CLEANED fullText we've already sent
  // to onToken. Each new raw chunk goes into fullText, we re-strip tool-
  // call scaffolding on the whole thing, then emit only the new suffix.
  let stripCursor = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by blank lines; each frame has "data: {...}"
      // lines. Gemini-OpenAI-compat sends one "data:" per chunk. Split on
      // newlines and accumulate any partial line at the end of the buffer.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            // Defer per-chunk emission: we buffer into fullText, then emit
            // ONLY the new part after stripping any tool-call scaffolding
            // (like 'CALL foo(bar)' that Gemini 3.x sometimes emits as
            // literal content instead of structured tool_calls).
            const cleanSoFar = stripToolCallScaffolding(fullText);
            // Compute the incremental delta between what we've already shown
            // the caller and the newly cleaned text. Track via an outer var.
            if (cleanSoFar.length > stripCursor) {
              const visible = cleanSoFar.slice(stripCursor);
              stripCursor = cleanSoFar.length;
              onToken?.(visible);
            }
          }
        } catch {}
      }
    }
  } catch (e) {
    if (e?.name === "AbortError") return { aborted: true, text: stripToolCallScaffolding(fullText), raw: fullText };
    console.warn("streamChat read error:", e);
    return { error: e?.message || "read_error", text: stripToolCallScaffolding(fullText), raw: fullText };
  }
  return { text: stripToolCallScaffolding(fullText).trim(), raw: fullText };
}

// The known tool names, for anchoring the CALL-leak patterns below.
const TOOL_NAME_RE = "(?:get_stock_price|get_crypto_price|search_stocks|get_market_news|get_user_portfolio|get_trade_history|\\w+)";

// Same names WITHOUT the \w+ catch-all, for the riskier mid-line strip.
// Anchoring on real names only means we can safely cut "CALL get_stock" out
// of the middle of a sentence without ever eating ordinary prose.
//
// Why that case exists: naazakhtar asked about Orient Electric on 2026-04-27
// and got back, literally, "CALL get_stockic is trading at ₹219.60" — the
// model emitted "CALL get_stock" and then ran straight into the tail of
// "Electric". Neither the own-line nor the end-of-line pattern catches that,
// because there is prose on both sides of it.
const KNOWN_TOOL_RE = "(?:get_stock_price|get_stock|get_crypto_price|get_crypto|search_stocks|get_market_news|get_user_portfolio|get_trade_history)";

// Strip the tool-use scaffolding and self-narration that the Gemini chat
// models periodically emit as LITERAL text instead of as structured
// tool_calls. Users must never see any of it.
//
// Every pattern here corresponds to something found in the production
// coach_messages log, not a hypothetical:
//   "CALL get_market_news"                      — no parens, own line
//   "...banking stocks for you. CALL search_stocks(\"Banking\")"  — inline
//   "Ah, gotcha! ...\n\nCALL get_user_portfolio\n\nYou're currently at ..."
//   "The user is asking if the market is closed today. I need to check ..."
// The previous regexes required BOTH parentheses AND a full-line anchor, so
// all four leaked through verbatim.
export function stripToolCallScaffolding(text) {
  if (!text) return "";
  let s = String(text);

  // 1. "CALL tool_name(...)" or bare "CALL tool_name" — own-line form,
  //    parentheses optional. Drop the whole line.
  s = s.replace(new RegExp(`^[ \\t]*CALL[ \\t]+${TOOL_NAME_RE}[ \\t]*(?:\\([^)]*\\))?[ \\t]*\\r?\\n?`, "gmi"), "");
  // 2. Same thing INLINE at the end of a sentence. Keep the prose before it.
  s = s.replace(new RegExp(`[ \\t]*\\bCALL[ \\t]+${TOOL_NAME_RE}[ \\t]*(?:\\([^)]*\\))?[ \\t]*(?=$|\\r?\\n)`, "gmi"), "");
  // 3. Bracketed / parenthesised annotations.
  s = s.replace(/^[ \t]*\[(?:tool|function)[ _]?call[^\]]*\][ \t]*\r?\n?/gmi, "");
  s = s.replace(/\[(?:tool|function)[ _]?call[^\]]*\]/gi, "");
  s = s.replace(/^[ \t]*\((?:no tool call|call [a-z_]+)[^)]*\)[ \t]*\r?\n?/gmi, "");
  // Same, but anywhere — "(call get_user_portfolio)" was a whole reply once.
  s = s.replace(/\((?:no tool call|call [a-z_]+)[^)]*\)/gi, "");
  // 3b. "CALL <real tool name>" anywhere at all, including mid-sentence with
  //     prose running straight into it. Deliberately AFTER the bracketed
  //     rules, so "(call get_user_portfolio)" is removed whole instead of
  //     being hollowed out into a stray "()". Anchored on actual tool names
  //     only, so it can never chew through ordinary prose like "call me
  //     old-fashioned" or "I'll call you back".
  s = s.replace(new RegExp(`\\bCALL[ \\t]+${KNOWN_TOOL_RE}[ \\t]*(?:\\([^)]*\\))?`, "gi"), "");
  // 4. Label prefixes the model sometimes echoes from the prompt examples.
  s = s.replace(/^[ \t]*(?:You say|You hear|Reply|Assistant|Response|Output)[ \t]*:[ \t]*/gmi, "");
  // 5. Unfilled <angle bracket> placeholders from the tone examples.
  s = s.replace(/<(?:price|change|pe|inr price|usd price|total|return|starting cash|cash|n|symbol|value|user query|literal reply prose)>/gi, "");
  // 6. Fenced tool_calls JSON blocks.
  s = s.replace(/```(?:tool_calls?|function|json)?\s*[\s\S]*?```/gi, (match) => {
    if (/\b(name|function|tool_calls?|arguments)\b/i.test(match)) return "";
    return match;
  });

  s = stripReasoningPreamble(s);

  s = s.replace(/\n{3,}/g, "\n\n");
  return s.replace(/^\s+/, "");
}

// Gemini frequently prefixes the visible reply with a sentence or two of
// self-directed planning: "The user is asking X. I need to do Y in Hindi."
// It reads as the coach talking about the user behind their back, and it
// showed up in roughly one in six logged turns. Drop those leading
// sentences — but only from the FRONT of the reply, and only while every
// sentence so far matches, so ordinary prose containing "I need to" mid-
// answer survives untouched.
// A planning sentence OPENS one of these ways...
const PREAMBLE_SENTENCE_RE = /^(?:the user (?:is |wants|seems|said|asked|needs|has |does|doesn|can|could|might|appears)|this (?:is a |question|user)|i (?:need to|should|will|must|have to|am going to|can (?:now|then) )|let me (?:check|call|pull|look|fetch|use|get)|my (?:apologies|task|job) )/i;
// ...AND talks about the machinery. Both conditions are required for the
// sentence-level peel, so an ordinary reply that happens to open with "I
// need to flag..." or "I should mention..." is left alone. The paragraph-
// level peel below is allowed to rely on the opener alone, because there
// every sentence in the block must match and a later block must survive.
const PREAMBLE_META_RE = /\b(the user|tool|call|translate|previous (?:explanation|message|answer)|in hindi|rephrase|provide (?:further )?guidance|check (?:the )?(?:market status|portfolio)|address this|oversight)\b/i;

function stripReasoningPreamble(text) {
  let s = String(text || "");
  // Work paragraph by paragraph first: the preamble is usually its own
  // block separated by a blank line.
  const paras = s.split(/\n\s*\n/);
  while (paras.length > 1 && isPreambleBlock(paras[0])) paras.shift();
  s = paras.join("\n\n");

  // Then peel leading sentences within the (possibly single) first block.
  let guard = 0;
  while (guard++ < 4) {
    const m = s.match(/^\s*([^.!?\n]*[.!?])(\s+)/);
    if (!m) break;
    const sentence = m[1].trim();
    if (!PREAMBLE_SENTENCE_RE.test(sentence) || !PREAMBLE_META_RE.test(sentence)) break;
    const rest = s.slice(m[0].length);
    if (!rest.trim()) break;          // never strip away the whole reply
    s = rest;
  }
  return s;
}

function isPreambleBlock(block) {
  const b = String(block || "").trim();
  if (!b) return false;
  if (b.length > 400) return false;
  // Every sentence in the block must look like planning.
  const sentences = b.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
  if (!sentences.length) return false;
  return sentences.every(x => PREAMBLE_SENTENCE_RE.test(x));
}

// -----------------------------------------------------------------------------
// Persist a chat turn (user + assistant pair) to coach_messages. v142:
// coach_messages is now the single source of truth for chat history —
// rebuildChatSessionsFromDb on next boot reconstructs the multi-session
// UI + side-panel log from these rows.
//
// `sessionId` groups the /chat multi-session UI (maps to the session.id in
// chatSessions.js). `surface` is one of "chat_page" / "side_panel" so the
// client can split the two surfaces when rebuilding. Both are optional —
// missing values fall back to the 30-min time-gap session heuristic for
// legacy rows. Fire-and-forget: any DB error never affects the chat UX.
// -----------------------------------------------------------------------------
export async function logChatTurn({ userText, assistantText, model, sessionId, surface }) {
  try {
    const mod = await import("../db/sync.js");
    if (!mod?.dbAddCoachMessage) return;
    if (userText && userText.trim()) {
      mod.dbAddCoachMessage({
        eventType: "chat_user",
        triggerSymbol: null,
        payload: { text: String(userText).slice(0, 4000) },
        model: null,
        sessionId: sessionId || null,
        surface: surface || null,
      }).catch(() => {});
    }
    if (assistantText && assistantText.trim()) {
      mod.dbAddCoachMessage({
        eventType: "chat_assistant",
        triggerSymbol: null,
        payload: { text: String(assistantText).slice(0, 8000) },
        model: model || null,
        sessionId: sessionId || null,
        surface: surface || null,
      }).catch(() => {});
    }
  } catch {}
}

// -----------------------------------------------------------------------------
// Heuristic: does this user message likely need live data (tool-use)?
// Used by the chat page to decide between the fast-streaming path and the
// slower runAgent tool-loop. Intentionally conservative — false positives
// just mean we skip streaming for one message, which is cheap; false
// negatives mean the user's "what's TCS at?" gets answered without live
// data, which is worse.
// -----------------------------------------------------------------------------
// Questions about the user's OWN account. These are the ones that hurt most
// when missed: with no tools the model either denies having the data ("I
// can't access your specific financial details" — logged against a real user
// on 2026-09-12) or, worse, invents a portfolio. Hinglish included, because
// a large share of real traffic is Hinglish.
const SELF_DATA_RE = new RegExp([
  "\\b(my|mine|our)\\b.*\\b(portfolio|holding|holdings|stock|stocks|share|shares|fund|funds|posit|invest|money|cash|balance|worth|value|profit|loss|gain|return|trade|trades|account)",
  "\\b(portfolio|holdings|report card|watchlist)\\b",
  "\\b(how much|how many|what.s my|whats my|hows my|how am i|am i in|do i own|did i|have i|i own|i hold|i bought|i sold|i made)\\b",
  "\\b(loss|profit|gain|return|pnl|p&l)\\b.*\\b(my|me|i)\\b",
  "\\b(my|me|i)\\b.*\\b(loss|profit|gain|return|pnl|p&l)\\b",
  "\\b(show|list|check|review|rate|analyse|analyze|overview|opinion|summary)\\b.*\\b(my|mine|me)\\b",
  "\\bi (?:have|had|has)\\b.*\\b(made|bought|sold|invested|owned|held)\\b",
  "\\b(best|worst|first|last|recent)\\b.*\\b(trade|trades|buy|sell|pick|position)\\b",
  // Hinglish
  "\\b(mera|meri|mere|mujhe|maine|mene|hamara|humara)\\b.*\\b(portfolio|stock|stocks|share|shares|paisa|paise|profit|loss|fayda|nuksan|account|order|request)",
  "\\bkitna\\b.*\\b(profit|loss|paisa|paise|value|fayda|nuksan)\\b",
  "\\b(order|orders|amo)\\b.*\\b(pending|queued|cancel|execute|placed|kab|nahi)\\b",
  "\\b(kab|kyu|kyun)\\b.*\\b(order|execute|place|accept)\\b",
].join("|"), "i");

// Market open/closed/hours — the model has repeatedly answered this from
// memory and got it wrong (it declared the market open on a Saturday and
// quoted a fabricated Nifty level two minutes after agreeing it was shut).
// Route to the tool path so the runtime market-status block is in scope.
const MARKET_STATUS_RE = /\b(market|nse|bse|exchange|trading)\b.*\b(open|close|closed|closing|band|khula|khulega|chalu|hours|timing|today|aaj|holiday|chuti|chhutti)\b|\b(band|khula|khulega)\b.*\b(market|nse|bse)\b/i;

// Explicit market-data nouns.
const DATA_NOUN_RE = /\b(price|prices|quote|rate|ltp|cmp|news|headline|headlines|market cap|marketcap|market capitalisation|market capitalization|p\/?e|pe ratio|p\/?b|valuation|movers|gainers|losers|top performers|52 week|52-week|day high|day low)\b/i;

// Discovery / screening — needs search_stocks, not a canned essay.
const DISCOVERY_RE = /\b(bank|banks|banking|it stocks|pharma|auto|fmcg|energy|metal|metals|cement|infra|infrastructure|psu|realty|telecom|defence|defense|rail|railway|shipping|chemical|textile|sector|sectors|compan(?:y|ies)|which stock|which stocks|what stock|what stocks|suggest.*stock|list.*stock|show.*stock|find.*stock|top \d+|best.*stock|stocks? (?:to|in|for|under|like))\b/i;

// Crypto — broader than the old hardcoded five.
const CRYPTO_RE = /\b(crypto|cryptocurrency|bitcoin|btc|ethereum|eth|solana|sol|dogecoin|doge|shiba|shib|xrp|ripple|cardano|ada|polkadot|dot|polygon|matic|avalanche|avax|litecoin|ltc|tron|trx|chainlink|link|monero|xmr|binancecoin|bnb|usdt|tether)\b/i;

// Index names. We have no index tool, but these still belong on the tool
// path: the model must be told to look rather than left alone to invent a
// Nifty level (it produced a fabricated 22,419.50 on a Saturday).
const INDEX_RE = /\b(nifty|sensex|bank ?nifty|bse|nse|index|indices)\b/i;

// Pure-concept questions that must NOT pay the tool-loop latency, even
// though they contain words like "market" or "stock".
const CONCEPT_RE = /^(what(?:'s| is| are)?|how (?:do|does|can|should)|why|explain|define|tell me about|meaning of|difference between|who is|who was)\b/i;
const CONCEPT_TOPIC_RE = /\b(compounding|compound interest|sip|systematic investment|diversif|inflation|repo rate|ipo|etf|mutual fund|nav|dividend|bond|volatility|beta|drawdown|ltcg|stcg|tax|80c|elss|ppf|demat|finfluencer|scam|ponzi|bubble|harshad mehta|dot-?com|recession|crash|bear market|bull market|short selling|leverage|margin|stop loss|limit order|market order|amo)\b/i;

// All-caps chatter that the ticker-shaped-token rule would otherwise catch.
const ALLCAPS_CHATTER = /^(HELLO|HI|HII|HAI|HEY|YO|YES|YEAH|NO|NAH|OK|OKAY|THANKS|THANK|PLS|PLEASE|SURE|WHAT|WHY|HOW|WHO|WHEN|WHERE|LOL|LMAO|OMG|BRO|BRUH|TEST|TESTES|TESTING|WTF|IDK|IDU|AND|THE|FOR|YOU|ARE|NOT|CAN|ALL|ANY|NEW|NOW|WRAP|UP|HELP|STOP|GOOD|NICE|COOL|WOW|HMM|AI|PWNED)$/;

// -----------------------------------------------------------------------------
// Heuristic: does this user message likely need live data (tool-use)?
// Used by the chat page and the side panel to choose between the fast
// streaming path (NO tools at all) and the slower runAgent tool-loop.
//
// The asymmetry is severe and one-directional. A false positive costs one
// message's worth of extra latency. A false negative means the streaming
// model is asked a data question with no tools attached — and it answers
// anyway, either refusing ("I can't access your financial details") or
// fabricating. Measured against the logged chat corpus, the previous
// keyword list missed ~72% of messages that genuinely needed data. So:
// lean hard toward true.
// -----------------------------------------------------------------------------
// Short follow-ups that only make sense as a continuation of the previous
// turn. "i mean on stocksaathi" carries no keyword of its own, but it was
// the message that pushed the model onto the tool-less path where it
// answered a portfolio question by reciting the system prompt's example
// figures back to the user as if they were real.
const CONTINUATION_RE = /^(?:i mean\b|no[, ]|nope\b|not that\b|the other\b|and\b|but\b|also\b|what about\b|how about\b|ok(?:ay)?[, ]|yes\b|yeah\b|ya\b|sure\b|do it\b|go on\b|more\b|again\b|u said\b|you said\b|show me\b|then\b|so\b|\?)/i;

/**
 * @param {string} text            the new user message
 * @param {Array}  [history]       prior turns, newest last, as {role, text|content}
 */
export function needsLiveData(text, history) {
  const raw = String(text || "");
  const t = raw.toLowerCase().trim();
  if (!t) return false;

  // The user's own account always needs get_user_portfolio.
  if (SELF_DATA_RE.test(t)) return true;
  if (MARKET_STATUS_RE.test(t)) return true;

  // "my <anything>" in a very short message — covers typos like "my
  // orotfdilio" that no keyword list will ever match.
  if (/^(?:my|mera|meri|mere)\b/i.test(t) && t.split(/\s+/).length <= 4) return true;

  // A short continuation inherits the previous user turn's routing. Without
  // this, a two-word clarification drops off the tool path mid-thread.
  if (Array.isArray(history) && history.length && (t.split(/\s+/).length <= 8 || CONTINUATION_RE.test(t))) {
    const prevUser = [...history].reverse()
      .find(m => m && m.role === "user" && (m.text || m.content));
    const prevText = prevUser ? String(prevUser.text ?? prevUser.content ?? "") : "";
    // Guard against unbounded recursion: resolve the previous turn WITHOUT
    // passing history along.
    if (prevText && prevText !== raw && needsLiveData(prevText)) return true;
  }

  // A definitional question about a concept is answerable without tools,
  // even when it mentions "market" or "stock" — unless it also names an
  // actual instrument, which the checks further down will catch.
  const isConcept = CONCEPT_RE.test(t) && CONCEPT_TOPIC_RE.test(t) && !DATA_NOUN_RE.test(t);

  if (!isConcept) {
    if (DATA_NOUN_RE.test(t)) return true;
    if (DISCOVERY_RE.test(t)) return true;
  }
  if (CRYPTO_RE.test(t)) return true;
  if (INDEX_RE.test(t)) return true;

  // Any token that resolves against the real instrument universe — company
  // names included, so "Orient Electric" and "Bajaj Finance" route correctly
  // instead of relying on a hardcoded 30-ticker list.
  if (mentionsKnownInstrument(raw)) return true;

  // Ticker-shaped ALL-CAPS token in the original casing, minus chatter.
  const caps = raw.match(/\b[A-Z][A-Z&-]{2,9}\b/g) || [];
  if (caps.some(c => !ALLCAPS_CHATTER.test(c))) return true;

  return false;
}

// Scan 1–3 word n-grams against the instrument universe. Words shorter than
// 3 chars and common English filler never resolve, so this is cheap and
// quiet. Returns true on the first hit.
const NGRAM_STOPWORDS = new Set([
  "all", "and", "the", "for", "you", "are", "not", "can", "any", "new", "now",
  "how", "what", "why", "who", "when", "this", "that", "with", "from", "your",
  "its", "was", "has", "have", "will", "good", "best", "more", "less", "than",
  "buy", "sell", "hold", "long", "short", "high", "low", "big", "top", "one",
  "two", "ten", "get", "got", "see", "say", "tell", "give", "make", "know",
  "like", "want", "need", "some", "many", "much", "very", "just", "only",
  // Ordinary words that are also the FIRST word of a listed company name
  // ("India Cements", "Time Technoplast", "Force Motors", "Future Retail").
  // Multi-word n-grams still match those names in full; it's the bare
  // single-word form that would otherwise fire on casual chat.
  "india", "indian", "time", "first", "next", "total", "future", "global",
  "point", "style", "care", "life", "home", "city", "star", "force", "group",
  "power", "world", "unit", "value", "smart", "super", "prime", "grand",
]);

function mentionsKnownInstrument(raw) {
  const words = String(raw)
    .replace(/[^\p{L}\p{N}&\-\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return false;
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n).join(" ");
      if (gram.length < 3) continue;
      if (n === 1 && NGRAM_STOPWORDS.has(gram.toLowerCase())) continue;
      try { if (resolveSymbolFuzzy(gram, { allowStub: false })) return true; } catch (_) {}
    }
  }
  return false;
}

// -----------------------------------------------------------------------------
// True when the model's raw reply was NOTHING BUT tool-call scaffolding, i.e.
// stripping it leaves nothing to show. Seen live on the streaming path:
// "show me banking stocks" came back as the single line
//   CALL search_stocks("Banking")
// Before the stripper that leaked verbatim; after it, the bubble would be
// empty and the user would get "I went quiet there" — still a dead end.
//
// Callers use this to RE-ROUTE the turn through runAgent (which has real
// tools) instead of apologising. The model was right that it needed a tool;
// it was just on the path that has none.
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// True when the reply is the model ASKING PERMISSION to do a lookup instead of
// doing it. "Want me to pull that up?" / "Shall I check?" / "Let me know and
// I can search."
//
// The prompt forbids this, but a prompt rule is a preference, not a guarantee.
// destroyer04's transcript is full of it even on the tool path: "Tell me new
// stocks to invest" came back as "Let me know what you're looking for, and I
// can help you search"; "Banks" produced five bank names with no prices and
// "Would you like to know the current price for any of these?".
//
// The user already asked. Treat the question as the permission: callers use
// this to silently re-run the turn through runAgent, which has real tools, and
// replace the reply. Deliberately narrow — it must match an OFFER, not an
// ordinary follow-up question at the end of a real answer, so it only fires
// when the reply is SHORT and carries no data of its own.
// -----------------------------------------------------------------------------
const OFFER_RE = new RegExp([
  "\\bwant me to\\b",
  "\\bshall i\\b",
  "\\bdo you want me to\\b",
  "\\bwould you like (?:me )?to\\b",
  "\\bwould you like to (?:know|see|check)\\b",
  "\\blet me know (?:and|if|what|which|your)\\b",
  "\\bi can (?:help you )?(?:pull|fetch|look|search|check|find|get)\\b",
  "\\bi'?ll need to (?:pull|fetch|look|check)\\b",
  "\\btell me (?:what|which)\\b.{0,40}\\band i(?:'| w)?ll\\b",
].join("|"), "i");

export function looksLikeLookupOffer(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  // A reply carrying actual figures is an answer, not a dodge.
  if (/₹\s?[0-9]|[0-9]+(?:\.[0-9]+)?\s?%/.test(s)) return false;
  // Long replies are explanations that happen to end with an offer.
  if (s.length > 400) return false;
  return OFFER_RE.test(s);
}

export function isToolCallOnly(raw) {
  const s = String(raw || "").trim();
  if (!s) return false;
  if (stripToolCallScaffolding(s).trim()) return false;
  return /CALL\s+\w+|\[(?:tool|function)[ _]?call|tool_calls/i.test(s);
}
