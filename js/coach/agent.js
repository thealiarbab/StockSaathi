// =============================================================================
// AGENT — Real LLM with tool-use. Groq-first (free + fast), BYO-key fallback.
//
// Groq Llama 3.3 70B: 500+ tokens/sec, free tier generous enough for 100-user
// pitch demos, OpenAI-compatible tool-use API. User's own key (if set in
// Settings) goes direct to Groq; otherwise we go through /api/chat which the
// backend proxies using GROQ_API_KEY env var.
// =============================================================================

import { getInstrument, getAllInstruments, STOCKS, MUTUAL_FUNDS } from "../data/universe.js";
import { getQuote, getQuoteBatch, getFundamentals } from "../data/marketData.js";
import { listPendingOrders, listAllOrders } from "../features/limitOrders.js";
import { getNews } from "../data/news.js";
import { getState, getPortfolioValue } from "../state.js";
import { SYSTEM_PROMPT, NO_TOOLS_NOTE } from "./persona.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const BACKEND_URL = "/api/chat";
// MODEL here is a client-side hint only — /api/chat overrides it with the
// actual Gemini model based on the profile. Kept short so it still works
// if someone sets their own Groq key (legacy "bring your own key" path).
const MODEL = "llama-3.3-70b-versatile";
// NO OUTPUT CAP. We do not send max_tokens at all, so each upstream uses its
// own full output window.
//
// It used to be 512, on the theory that a smaller budget means less internal
// reasoning and therefore a snappier reply. What it actually bought was
// replies chopped off mid-word:
//
//   "That would be your mutual fund (MF_151908), which is currently flat"
//   "The 21 EMA is an Exponential Moving Average that tracks the average
//    price over the last"
//   "My apologies! It seems I"
//
// The subtle part is WHY only some replies were cut. The budget is shared
// with the model's internal reasoning tokens, and the two profiles use
// different models:
//
//   profile "chat" -> gemini-2.5-flash-lite, which does NOT think. All 512
//                     tokens went to visible text (~2,000 chars), so
//                     conversational answers were never truncated.
//   profile "fast" -> gemini-2.5-flash, which DOES think. Reasoning came out
//                     of the same 512, leaving very little for the answer.
//
// api/chat.js already documents this exact failure mode elsewhere: "2.5 Flash
// spends ~1900 reasoning-tokens on strict-JSON requests, which breaks crash
// replay (hits max_tokens with the JSON itself only 70 tokens long)."
//
// That is why long conceptual answers were fine while portfolio and trade
// questions — the ones that go through tools on the "fast" profile — kept
// getting cut. trimToSentence() stays as a safety net for any cap imposed
// upstream that we do not control.
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
  // ---------------------------------------------------------------------------
  // The two tools below close a fabrication vector measured on 2026-09-14.
  //
  // With neither tool present, an eval of 30 real questions showed the model
  // answering "what's on my watchlist" and "do i have any pending orders" by
  // calling get_user_portfolio — which returns cash and holdings and contains
  // NEITHER. It then has data that cannot answer the question and must either
  // invent an answer or deny having one. That is precisely the COACH_FIXES §1
  // pattern, where the coach invented a whole trading record and defended it
  // for four turns because it had get_user_portfolio and no get_trade_history.
  //
  // Telling the model not to guess was never the fix. Giving it the data is.
  // ---------------------------------------------------------------------------
  {
    type: "function",
    function: {
      name: "get_watchlist",
      description:
        "The symbols the user has saved to their watchlist, with current prices. Use for 'my watchlist', 'what am I tracking', 'stocks I'm watching'. This is DIFFERENT from what they own — get_user_portfolio does NOT contain the watchlist.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_fundamentals",
      description:
        "Company fundamentals from the app's daily-refreshed cache: P/E, P/B, EPS (trailing 12 months), ROE, market cap, dividend yield, beta, debt-to-equity and the 52-week high/low, with the date they were refreshed. Use for ANY question about profit, earnings, EPS, ROE, valuation, P/E, debt, market cap, dividends or 'is it expensive'. Never state these figures from memory.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "NSE ticker or company name." },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_limit_orders",
      description:
        "The user's limit orders and AMOs — pending, filled and cancelled. Use for 'my orders', 'pending orders', 'did my order execute', 'why hasn't my order filled', 'cancel', 'AMO'. get_user_portfolio does NOT contain orders; an unfilled order is not a holding yet.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Filter: 'pending' (default), 'filled', 'cancelled', or 'all'.",
          },
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
    const [q, fund] = await Promise.all([
      getQuote(sym),
      // universe.js valuation fields are hand-typed and drift after splits
      // and results (D9); the nightly cache is the real one. Bounded so a
      // slow fundamentals call never holds up a price.
      Promise.race([getFundamentals(sym).catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]),
    ]);
    const inst = getInstrument(sym);
    if (!q || !inst) return { ok: false, error: `No quote for ${sym}.` };
    // getQuote's last resort is a synthetic walk meant for charts. For a
    // symbol NSE does not list (the plausible-ticker fallback above lets
    // "ZOMATO" through) that walk was handed back as a price: the coach told
    // users Zomato was at ₹1,386.89 while ETERNAL closed at ₹323.45, and that
    // it was "definitely on the app". Never quote an invented number.
    if (q.source === "synthetic") {
      return { ok: false, error: `No real price for "${raw}" — NSE has no listing under ${sym} (it may be renamed, delisted or misspelt). Do not quote any price; call search_stocks with the company name.` };
    }
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
      pe_ratio: fund?.pe_ratio != null ? +Number(fund.pe_ratio).toFixed(1) : null,
      pb_ratio: fund?.pb_ratio != null ? +Number(fund.pb_ratio).toFixed(2) : null,
      market_cap_crore_inr: fund?.market_cap ? Math.round(fund.market_cap / 1e7) : null,
      risk_tier: inst.risk,
      data_source: q.source,
      is_live: !q.stale,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// C23: the coach quoted HDFC Bank's "FY2023-24 net profit of over ₹60,000
// crore" and an ROE of "15-17%" from memory, while the cache said ROE 13.3%.
// fundamentals_cache (refreshed nightly) is the only source it may use.
async function execGetFundamentals(input) {
  const raw = String(input.symbol || "").trim();
  const sym = resolveSymbolFuzzy(raw);
  if (!sym) return { ok: false, error: `No NSE stock matching "${raw}". Try search_stocks.` };
  try {
    const f = await getFundamentals(sym);
    if (!f) return { ok: false, error: `No fundamentals on file for ${sym}. Say you don't have them; do not estimate.` };
    const num = (v, d = 2) => (typeof v === "number" && Number.isFinite(v) ? +v.toFixed(d) : null);
    const asOf = f.cached_at_ms ? new Date(f.cached_at_ms).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : null;
    return {
      ok: true,
      symbol: sym,
      name: f.name || getInstrument(sym)?.name || sym,
      sector: f.sector || null,
      industry: f.industry || null,
      pe_ratio: num(f.pe_ratio ?? f.pe_ttm, 1),
      pb_ratio: num(f.pb_ratio, 2),
      eps_ttm_inr: num(f.eps, 2),
      roe_pct: f.roe != null ? num(f.roe * 100, 1) : null,
      market_cap_crore_inr: f.market_cap ? Math.round(f.market_cap / 1e7) : null,
      dividend_yield_pct: f.dividend_yield != null ? num(f.dividend_yield * 100, 2) : null,
      beta: num(f.beta, 2),
      debt_to_equity: num(f.debt_to_equity, 2),
      fifty_two_week_high_inr: num(f.fifty_two_week_high, 2),
      fifty_two_week_low_inr: num(f.fifty_two_week_low, 2),
      as_of: asOf,
      note: "No total profit or revenue figure is available here, and no fiscal-year breakdown. If asked for one, say so and offer EPS (trailing 12 months) instead. Fields that are null are unknown: say you don't have them.",
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
      // A synthetic chart walk is not a price; fall back to cost like a miss.
      const curPx = q && q.source !== "synthetic" ? q.pricePaise : h.avgCostPaise;
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

/**
 * The user's watchlist, with live prices.
 *
 * Uses getQuoteBatch rather than a getQuote loop. The single-symbol path goes
 * to /api/quote, which is the ONE quote endpoint with no Supabase cache layer
 * and a 4-way serial Yahoo retry; the batch path goes to /api/live-quote, which
 * reads and writes the shared quote_cache. N symbols cost one request, not N.
 */
async function execGetWatchlist() {
  const state = getState();
  const symbols = Array.isArray(state?.watchlist) ? state.watchlist.filter(Boolean) : [];
  if (!symbols.length) {
    return {
      ok: true,
      count: 0,
      watchlist: [],
      note: "The watchlist is EMPTY. Say exactly that. Do not list holdings instead — a watchlist and a portfolio are different things.",
    };
  }
  let quotes = {};
  try { quotes = (await getQuoteBatch(symbols)) || {}; } catch { quotes = {}; }
  return {
    ok: true,
    count: symbols.length,
    // Field names follow normalizeFromApi in data/marketData.js: quotes are
    // normalised to pricePaise / changePct, and changePct is a FRACTION, not a
    // percentage — hence the ×100, matching execGetStockPrice above. Reading
    // q.price here would silently yield undefined for every row and report the
    // whole watchlist as unpriceable.
    watchlist: symbols.map((sym) => {
      const inst = getInstrument(sym);
      const q = quotes[sym];
      const hasPrice = q && Number.isFinite(q.pricePaise);
      return {
        symbol: sym,
        name: inst?.name || sym,
        price_inr: hasPrice ? +(q.pricePaise / 100).toFixed(2) : null,
        day_change_pct: q && Number.isFinite(q.changePct) ? +(q.changePct * 100).toFixed(2) : null,
        price_unavailable: hasPrice ? undefined : true,
      };
    }),
    note: "These are symbols the user is TRACKING, not ones they own.",
  };
}

/**
 * The user's limit orders / AMOs.
 *
 * The null-vs-empty distinction is load-bearing and must survive to the model.
 * listPendingOrders() returns [] when the user genuinely has no orders and
 * null when the lookup FAILED — and the comment above it in limitOrders.js
 * says why: a real pending RELIANCE AMO once existed while the page showed 0,
 * and "silently showing zero is the worst possible failure here." A coach that
 * turns "I couldn't check" into "you have none" recreates that bug in prose.
 */
async function execGetLimitOrders(args = {}) {
  const status = String(args.status || "pending").toLowerCase();
  let rows;
  try {
    rows = status === "pending"
      ? await listPendingOrders()
      : await listAllOrders(50);
  } catch {
    rows = null;
  }
  if (rows === null) {
    return {
      ok: false,
      error: "lookup_failed",
      note: "Could NOT read the user's orders — this is a failure, NOT an empty list. Tell them you couldn't check right now and to try again. Never say they have no orders based on this.",
    };
  }
  const filtered = (status === "pending" || status === "all")
    ? rows
    : rows.filter((r) => String(r.status).toLowerCase() === status);
  if (!filtered.length) {
    return {
      ok: true,
      count: 0,
      orders: [],
      note: `No ${status === "all" ? "" : status + " "}orders found. The lookup SUCCEEDED and the list is genuinely empty — say so plainly.`,
    };
  }
  return {
    ok: true,
    count: filtered.length,
    orders: filtered.slice(0, 25).map((r) => ({
      symbol: r.symbol,
      side: r.side,
      qty: r.qty,
      limit_price_inr: r.limit_price_paise != null ? r.limit_price_paise / 100 : null,
      status: r.status,
      placed_at: r.created_at,
      filled_at: r.filled_at || undefined,
      filled_price_inr: r.filled_price_paise != null ? r.filled_price_paise / 100 : undefined,
    })),
    note: "A PENDING order is not a holding yet. The only honest reasons one is unfilled are (a) the market has not opened, or (b) the price has not reached their limit. Order matching runs server-side on a schedule — the user does NOT need the app open. If they say it has been stuck for days, that is OUR bug: tell them to report it, never explain it away.",
  };
}

const EXECUTORS = {
  get_stock_price: execGetStockPrice,
  get_trade_history: execGetTradeHistory,
  get_crypto_price: execGetCryptoPrice,
  search_stocks: execSearchStocks,
  get_market_news: execGetMarketNews,
  get_user_portfolio: execGetUserPortfolio,
  get_watchlist: execGetWatchlist,
  get_limit_orders: execGetLimitOrders,
  get_fundamentals: execGetFundamentals,
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
    // Zomato Ltd renamed itself Eternal Ltd in 2025 (NSE: ETERNAL).
    zomato: "ETERNAL", "zomato ltd": "ETERNAL", "zomato limited": "ETERNAL",
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
async function callLLM({ apiKey, system, messages, tools, profile = "fast", reasoningEffort }) {
  // Convert chat history (role/content string) to OpenAI format
  const openaiMessages = [
    { role: "system", content: system },
    ...messages,
  ];
  const body = {
    model: MODEL,
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

  // PER-PHASE THINKING BUDGET.
  //
  // api/chat.js applies its per-profile default ONLY when the caller leaves
  // reasoning_effort undefined ("a caller that sets reasoning_effort
  // explicitly always wins"), so this is a real lever from here with no
  // server change required.
  //
  // It matters because the two phases of a tool turn want opposite things,
  // and the `fast` profile's single "low" setting was serving both:
  //
  //   deciding WHICH tool to call — a genuine judgement, ~30 tokens out
  //   WRITING the answer          — no decision left, data already in hand,
  //                                 and the output is long
  //
  // Measured against production 2026-09-14, same model, same prompt, streamed:
  //
  //   "low"      ttft 3.24-4.37s, complete 5.4-8.2s — and one run at
  //              17.8s/20.2s, which blew past the 9s upstream timeout and
  //              fell through to a slower model
  //   "minimal"  ttft 0.97-1.93s, complete 4.3-5.0s
  //
  // A 30-question eval showed "minimal" costs NOTHING in tool-choice accuracy
  // (27/29 both ways, 29/30 identical selections) but buys no latency on the
  // short decision turns either — the entire win is in the long writing turn.
  // So: keep the budget where the decision is, drop it where only prose is
  // left to emit.
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

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

  // Tracks whether the previous turn executed tools. If it did, THIS turn has
  // the results in hand and is only writing the answer, so it needs no
  // thinking budget — see the note in callLLM.
  let lastTurnRanTools = false;
  // One "look it up or leave it out" pass per reply (see unsourcedFigures).
  let figureNudged = false;

  while (loops < MAX_TOOL_LOOPS) {
    loops++;
    const resp = await callLLM({
      apiKey, system, messages: conv, tools: TOOLS, profile,
      reasoningEffort: lastTurnRanTools ? "minimal" : undefined,
    });
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

      // Append assistant tool-call turn as-is. upstream_blocks (when the
      // proxy sends it) is opaque here and must go back untouched on the
      // next request: it carries the model's reasoning for this turn, which
      // the upstream requires alongside the tool results. /api/chat strips
      // it before any upstream that does not understand it.
      conv.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: toolCalls,
        ...(Array.isArray(msg.upstream_blocks) ? { upstream_blocks: msg.upstream_blocks } : {}),
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
      lastTurnRanTools = true;
      continue;
    }

    // Final text response — but sanitise first. Gemini 3 Flash Preview
    // sometimes narrates its tool-use in the content stream as literal text
    // like 'CALL search_stocks(query="...")' or '[Tool call: ...]' instead
    // of emitting a proper tool_calls JSON block. These strings MUST not
    // leak into the user-facing bubble — they're model-internal scaffolding.
    // We strip them wholesale; if the model hallucinated a result after
    // such a line we keep the prose around it (best-effort).
    let text = stripToolCallScaffolding(String(msg.content || "")).trim();
    // Hit the output ceiling? Never show a sentence that stops mid-word.
    if (choice.finish_reason === "length") text = trimToSentence(text);
    // A price, a "% today" or a $/₹ event figure that no tool returned
    // and nobody said: send the draft back once to be looked up, and drop
    // what still is not backed after that.
    const bad = text ? unsourcedFigures(text, figureSources(system, conv)) : [];
    if (bad.length) {
      if (!figureNudged && loops < MAX_TOOL_LOOPS - 1) {
        figureNudged = true;
        onStep?.({ stepIndex: loops, action: "figure_check", figures: bad });
        conv.push({ role: "assistant", content: text });
        conv.push({ role: "user", content: FIGURE_NUDGE(bad) });
        lastTurnRanTools = false;
        continue;
      }
      const trimmed = dropFigureSentences(text, bad);
      if (trimmed) text = trimmed;
    }
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

// News-shaped questions (C5). "news" alone already reached the tool path,
// and the model still answered from memory without calling get_market_news:
// "What is the latest news regarding oil prices and iran us war?" (6 Oct)
// came back with "Brent crude jumped back toward $80 a barrel last week".
// These are routed to tools AND the app fetches the headlines itself
// (prefetchNewsBlock) so the model never has to decide to look.
const NEWS_RE = /\b(news|khabar|khabre|khabren|khabrein|samachar|headlines?|latest|kya hua|kya chal raha|what happened|what'?s happening|war|iran|israel|ukraine|russia|tariffs?|budget|rbi|repo rate|fed|crude|brent|election|elections)\b|\bwhy\b.*\b(up|down|fall|falling|fell|drop|dropped|dropping|rise|rising|rose|crash|crashed|crashing|rally|rallying|jump|jumped)\b|\b(kyu|kyun|kyon)\b.*\b(gir|gira|giri|gire|girna|badh|badha|badhi|chadh|chadha|upar|neeche|niche)\b/i;

// Explicit market-data nouns.
const DATA_NOUN_RE = /\b(price|prices|quote|rate|ltp|cmp|news|headline|headlines|market cap|marketcap|market capitalisation|market capitalization|p\/?e|pe ratio|p\/?b|valuation|movers|gainers|losers|top performers|52 week|52-week|day high|day low|profit|profits|revenue|earnings|eps|roe|debt|dividend|dividends|munafa|kamai|fundamentals)\b/i;

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
  if (NEWS_RE.test(t)) return true;

  // "my <anything>" in a very short message — covers typos like "my
  // orotfdilio" that no keyword list will ever match.
  if (/^(?:my|mera|meri|mere)\b/i.test(t) && t.split(/\s+/).length <= 4) return true;

  // "yes" / "Yaa" / "ok" to an offer or promise to look something up.
  if (t.split(/\s+/).length <= 5 && AFFIRM_RE.test(t) && assistantOfferedLookup(history)) return true;

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

// -----------------------------------------------------------------------------
// Cut a truncated reply back to its last complete sentence.
//
// When the model hits the output ceiling it stops wherever it happens to be,
// which users see as a reply that just... stops. Real examples from the log:
//
//   "That would be your mutual fund (MF_151908), which is currently flat"
//   "The 21 EMA is an Exponential Moving Average that tracks the average
//    price over the last"
//   "My apologies! It seems I"
//
// Raising MAX_TOKENS makes this rare; this makes it survivable. Ending one
// sentence early reads as brevity. Ending mid-word reads as broken.
// -----------------------------------------------------------------------------
/** True for a news-shaped question (see NEWS_RE). */
export function isNewsQuestion(text) {
  return NEWS_RE.test(String(text || "").toLowerCase());
}

/**
 * For a news-shaped question, fetch the headlines before the model is asked
 * and return a system-prompt block carrying them, with the rule that the
 * news part of the answer comes from these and nothing else. "" otherwise.
 * Bounded: a slow feed costs at most `timeoutMs`, then the block says the
 * lookup failed (which also forbids describing events from memory).
 */
export async function prefetchNewsBlock(text, { limit = 8, timeoutMs = 4000 } = {}) {
  if (!isNewsQuestion(text)) return "";
  let res = null;
  try {
    res = await Promise.race([
      execGetMarketNews({ limit }),
      new Promise((r) => setTimeout(() => r(null), timeoutMs)),
    ]);
  } catch { res = null; }
  const rule = "Answer the news part ONLY from these headlines and name the source. If they do not cover what the user asked about, say so plainly. Never add events, prices, percentages or \"last week\" stories that are not in them.";
  if (!res?.ok) {
    return "\n\n# NEWS (looked up just now)\nThe news lookup failed this turn. Say you could not load today's headlines. Do not describe any current event, price move or recent story from memory.";
  }
  if (!res.headlines?.length) {
    return "\n\n# NEWS (looked up just now)\nThe news feed returned no headlines. Say so. Do not describe any current event, price move or recent story from memory.";
  }
  const lines = res.headlines.map((h) => {
    const age = Number.isFinite(h.hours_ago) ? `${h.hours_ago < 1 ? "<1" : Math.round(h.hours_ago)}h ago` : "recent";
    return `- ${h.headline} (${h.source || "source unknown"}, ${age}${h.sentiment ? `, ${h.sentiment}` : ""})`;
  }).join("\n");
  return `\n\n# NEWS (fetched by the app just now with get_market_news)\n${lines}\n\n${rule}`;
}

// -----------------------------------------------------------------------------
// Figures nobody looked up (C5/C6). The prompt has said "never invent a
// price" for months and the model still did, on both paths. Production:
//   "ADANIGREEN is currently at ₹1,845.20, down 0.45% today." (real ~₹1,313;
//      no price lookup ran)
//   "you've set HDFCBANK to buy at ₹700, but it usually trades much higher
//      (around ₹1,600-₹1,700 lately)." (it was ₹707; only the orders tool ran)
//   "Brent crude jumped back toward $80 a barrel last week" (no news lookup)
// "Did any tool run?" misses the HDFC case, so this compares numbers: a
// money figure, or a %-move with a time word, in a sentence about a stock or
// the market must match a number the model was actually given (system
// prompt + dossier, tool results, the conversation). Returns the offending
// figures as written. Pure, so scripts/test-coach-guards.mjs can run it.
// -----------------------------------------------------------------------------
const FIG_MONEY_RE = /(?:₹|\brs\.?|\binr|\$)\s?(\d[\d,]*(?:\.\d+)?)\s*(k|l|lakhs?|lacs?|cr|crores?)?\b/gi;
const FIG_PCT_RE = /([+-]?\d+(?:\.\d+)?)\s?%/g;
const FIG_TIME_RE = /\b(today|today's|todays|aaj|yesterday|kal|this week|last week|is hafte|pichle hafte|this month|last month|lately|recently|right now|currently|abhi|filhaal|so far|session)\b/i;
const FIG_MARKET_NOUN_RE = /\b(nifty|sensex|bank ?nifty|crude|brent|oil|gold|silver|bitcoin|btc|ethereum|eth|rupee|dollar|index)\b/i;
// All-caps words that are not instruments.
const FIG_NOT_TICKER = new Set(["SIP", "SIPS", "ETF", "ETFS", "NAV", "IPO", "IPOS", "RBI", "SEBI", "NSE", "BSE", "EMI", "GDP", "USD", "INR", "AMC", "PE", "PB", "EPS", "ROE", "ROI", "CAGR", "MF", "MFS", "FD", "FDS", "PPF", "ELSS", "LTCG", "STCG", "GST", "OK", "AI", "AMO", "AMOS", "LIMIT", "MARKET", "US", "UK", "IT", "FMCG", "PSU", "PSUS", "OMC", "OMCS", "CPI", "WPI", "YOY", "QOQ", "TTM", "EBITDA", "KYC", "UPI", "ATM", "CEO", "CFO", "NRI", "FII", "DII", "FIIS", "DIIS", "NPA", "NIM", "NOT", "AND", "THE", "BUY", "SELL", "HOLD", "NEVER", "ALWAYS", "NO", "YES", "TL", "DR", "FAQ", "PS", "NB", "IST", "AM", "PM", "LTP", "CMP", "OHLC", "DCA", "P", "E"]);
const FIG_TICKER_RE = /\b[A-Z][A-Z0-9&-]{1,14}\b/g;
// "It is trading at ₹4,064" after a sentence that named HAL; "closed at ₹…".
const FIG_PRONOUN_RE = /^(?:it|its|it's|this|that|the stock|the share|the shares|shares|the company|iska|iski|iske|ye|yeh|woh|wo)\b/i;
const FIG_PRICE_VERB_RE = /\b(trad(?:es|ing|ed) (?:at|around|near)|priced at|share price|closed at|opened at|quoting at|is at|was at)\b/i;
// A conditional worked example, not a claim about the market. ("For example,"
// is not one: production used it to introduce the real HDFC limit.)
const FIG_HYPOTHETICAL_RE = /\b(if|suppose|supposing|say you|let'?s say|imagine|agar|maan lo|maano|jaise ki)\b/i;

function _figValue(numStr, unit) {
  let v = parseFloat(String(numStr).replace(/,/g, ""));
  if (!Number.isFinite(v)) return null;
  const u = String(unit || "").toLowerCase();
  if (u === "k") v *= 1e3;
  else if (u === "l" || u.startsWith("lakh") || u.startsWith("lac")) v *= 1e5;
  else if (u === "cr" || u.startsWith("crore")) v *= 1e7;
  return v;
}

export function unsourcedFigures(reply, sources) {
  const text = String(reply || "");
  if (!text.trim()) return [];
  const known = [];
  const src = String(sources || "");
  for (const m of src.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k|l|lakhs?|lacs?|cr|crores?)?\b/gi)) {
    const plain = parseFloat(m[1].replace(/,/g, ""));
    if (!Number.isFinite(plain)) continue;
    known.push(plain, plain / 100, plain * 100);         // rupees, paise, fraction-as-%
    const withUnit = _figValue(m[1], m[2]);
    if (withUnit != null && withUnit !== plain) known.push(withUnit);
  }
  // Percentages are only "known" when they were given as percentages: a
  // number written with %, or a value under a pct / percent / change key
  // (as a fraction or in points). Any bare number would do otherwise: the
  // prompt's "1-3 sentences" alone vouched for an invented "up 3% today".
  const knownPct = [];
  for (const m of src.matchAll(/([+-]?\d+(?:\.\d+)?)\s?%/g)) knownPct.push(Math.abs(+m[1]));
  for (const m of src.matchAll(/[a-z_]*(?:pct|percent|change)[a-z_]*"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/gi)) {
    const v = Math.abs(+m[1]);
    knownPct.push(v, v * 100);
  }
  const nearMoney = (v) => known.some((k) => Math.abs(k - v) <= Math.max(0.015 * Math.abs(k), 0.5));
  // Rounding allowance follows the precision written: "0.45%" must match to
  // ±0.005, "3%" to ±0.5.
  const nearPct = (v, decimals) => {
    const tol = 0.5 * 10 ** -decimals + 1e-9;
    return knownPct.some((k) => Math.abs(k - v) <= Math.max(tol, 0.01 * k));
  };
  const bad = [];
  const sentences = text.replace(/\*\*/g, "").split(/(?<=[.!?])\s+|\n+/);
  let prevNamed = false;
  for (const s of sentences) {
    const tickers = (s.match(FIG_TICKER_RE) || []).filter((w) => !FIG_NOT_TICKER.has(w.replace(/[&-]/g, "")));
    const named = tickers.length > 0 || FIG_MARKET_NOUN_RE.test(s);
    const about = named || (prevNamed && FIG_PRONOUN_RE.test(s.trim())) || FIG_PRICE_VERB_RE.test(s);
    prevNamed = named || (prevNamed && FIG_PRONOUN_RE.test(s.trim()));
    if (FIG_HYPOTHETICAL_RE.test(s)) continue;
    const timed = FIG_TIME_RE.test(s);
    if (!about && !timed) continue;
    // Counts in the sentence ("10 shares"), so a total worked out from a
    // looked-up price (10 × ₹2,269.30 = ₹22,693) is not taken for an invention.
    const counts = [...s.replace(FIG_MONEY_RE, " ").matchAll(/\b(\d{1,4})\b/g)].map((m) => +m[1]).filter((n) => n > 1);
    for (const m of (about ? s.matchAll(FIG_MONEY_RE) : [])) {
      const v = _figValue(m[1], m[2]);
      if (v == null || v < 1 || nearMoney(v)) continue;
      // "₹8,23,000 crore" against the tool's market_cap_crore_inr: 823000.
      if (m[2] && nearMoney(parseFloat(m[1].replace(/,/g, "")))) continue;
      if (counts.some((n) => nearMoney(v / n))) continue;
      bad.push(m[0].trim());
    }
    // A %-move with a time word ("down 1.45% during today's session") is a
    // claim about the market even when the sentence only says "This".
    if (timed) {
      for (const m of s.matchAll(FIG_PCT_RE)) {
        const v = Math.abs(parseFloat(m[1]));
        const decimals = (m[1].split(".")[1] || "").length;
        if (Number.isFinite(v) && v > 0 && !nearPct(v, decimals)) bad.push(m[0].trim());
      }
    }
  }
  return [...new Set(bad)].slice(0, 6);
}

/** Remove every sentence that contains one of `figures`; keeps the rest. */
export function dropFigureSentences(text, figures) {
  if (!figures?.length) return text;
  const hit = (p) => figures.some((f) => p.replace(/\*\*/g, "").includes(f));
  return String(text || "").split("\n").map((line) => {
    if (!hit(line)) return line;
    return line.split(/(?<=[.!?।])\s+/).filter((p) => !hit(p)).join(" ");
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Everything the model was given this turn, as one string for
 * unsourcedFigures. The fixed persona and no-tools note are cut out: their
 * numbers are teaching examples, not facts ("pays 2.5% annual interest"
 * would otherwise vouch for an invented "up 3% today").
 */
export function figureSources(system, messages) {
  let sys = String(system || "");
  for (const fixed of [SYSTEM_PROMPT, NO_TOOLS_NOTE]) if (fixed) sys = sys.split(fixed).join("\n");
  const parts = [sys];
  for (const m of messages || []) {
    const c = m?.content ?? m?.text;
    parts.push(typeof c === "string" ? c : JSON.stringify(c ?? ""));
  }
  return parts.join("\n");
}

const FIGURE_NUDGE = (figs) => `[check] Your draft states ${figs.join(", ")}, and nothing you were given this turn contains ${figs.length > 1 ? "those figures" : "that figure"}. Call the tool that gives it (get_stock_price for a price or today's move, get_market_news for news and events), then write your whole answer again. Leave out any figure you cannot look up. Do not mention this check.`;

export function trimToSentence(text) {
  const s = String(text || "").trim();
  if (!s) return s;
  // Last sentence-ending punctuation that isn't a decimal point or an
  // abbreviation like "Rs." — require whitespace or end-of-string after it.
  const m = s.match(/^[\s\S]*[.!?…](?=\s|$)/);
  if (m && m[0].trim().length >= Math.min(60, s.length * 0.4)) {
    return m[0].trim();
  }
  // Nothing usable to cut back to (one long unfinished sentence). Say so
  // rather than pretending the fragment is the whole answer.
  return s + "…";
}

export function looksLikeLookupOffer(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  // A reply carrying actual figures is an answer, not a dodge.
  if (/₹\s?[0-9]|[0-9]+(?:\.[0-9]+)?\s?%/.test(s)) return false;
  // Long replies are explanations that happen to end with an offer.
  if (s.length > 400) return false;
  return OFFER_RE.test(s);
}

// -----------------------------------------------------------------------------
// The PROMISE shape — kept apart from OFFER_RE on purpose (see above: that one
// must stay narrow). An offer asks; a promise announces a lookup the model
// cannot perform on the tool-less path and then stops:
//
//   "I'll pull up a few of the biggest names... One sec while I grab those
//    live prices for you."
//   "Give me a moment to fetch those numbers."
//   "Hang tight, fetching those figures for you."
//
// From the 2026-10-13 chat audit: one user got three of these in a row and
// had to send "Yaa", "Yaa", "Mm", "Yes" before any number arrived. A promise
// is never a correct reply, so nothing it matches is a false positive worth
// protecting — but the same short, figure-free limits apply.
// -----------------------------------------------------------------------------
const PROMISE_RE = /\b(?:one sec(?:ond)?|give me a (?:sec(?:ond)?|moment|minute)|hang tight|hold on|bear with me|let me (?:grab|fetch|pull|get|check|look)|i'?ll (?:grab|fetch|pull|get|check|look up)|i am (?:grabbing|fetching|pulling)|i'?m (?:grabbing|fetching|pulling)|fetching (?:th|the|those|that|it)|grabbing (?:th|the|those|that|it)|abhi (?:check|nikaal|dekh)(?:ta|ti)? (?:hoon|hu)|ek (?:sec|second|minute) (?:ruko|do))\b/i;

export function looksLikeFetchPromise(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  if (/₹\s?[0-9]|[0-9]+(?:\.[0-9]+)?\s?%/.test(s)) return false;
  if (s.length > 400) return false;
  return PROMISE_RE.test(s);
}

// A short "yes" to an assistant turn that offered or promised a lookup. The
// continuation rule in needsLiveData only inherits the previous USER turn, so
// "Yaa" after "want me to pull up the big names?" fell onto the streaming
// path, which has no tools — and got another promise instead of the prices.
const AFFIRM_RE = /^(?:(?:pls|please|ok(?:ay)?|haan?|ha+|ji|yes|yeah|ya+|yep|yup|sure|mm+|hmm+|bilkul|theek hai|thik hai)[\s,.!]*)+(?:go ahead|do it|show(?: me)?|dikhao|batao|kar do|check karo|pull it)?[\s.!]*$|^(?:go ahead|do it|show me|dikhao|batao)\b/i;
const OFFERISH_RE = /\b(?:want me to|shall i|should i|would you like me to|do you want me to)\b.{0,60}\b(?:pull|fetch|check|show|look|get|grab|find|search|list)\b|\b(?:main|mai)\b.{0,40}\b(?:nikaal|check kar|dikha)/i;

function assistantOfferedLookup(history) {
  if (!Array.isArray(history) || !history.length) return false;
  const last = history[history.length - 1];
  if (!last || last.role !== "assistant") return false;
  const txt = String(last.text ?? last.content ?? "");
  return looksLikeLookupOffer(txt) || looksLikeFetchPromise(txt) || OFFERISH_RE.test(txt.slice(-300));
}

// -----------------------------------------------------------------------------
// The bare-list escape hatch.
//
// looksLikeLookupOffer above is deliberately narrow — short, figure-free, and
// matching a known offer phrase. That narrowness was validated 12/12 against
// real logged replies and must not be loosened; widening OFFER_RE re-opens the
// false positives it was built to avoid (a correct refusal reads a lot like an
// offer).
//
// But it leaves one shape uncovered, and it is the single most-reported one.
// Measured against production 2026-09-14, "fetch a list of 20 top bank stocks"
// returned, twice, ~750 chars of bank names with no prices at all, ending:
//
//   "Which of these categories interests you most?"
//
// That misses on BOTH counts: the reply is over the 400-char cap, and the
// closing phrase matches none of OFFER_RE's alternatives. So the escalation
// never fired and the user got exactly what persona.js forbids —
// "Do not hand over a bare list and ask whether they want the prices."
//
// This detector targets that shape specifically: a discovery answer that names
// several instruments and carries no figures. It does not care how the reply
// is phrased, which is why it catches an offer worded in a way nobody
// anticipated.
/**
 * Is this a discovery / screening question — "bank stocks", "suggest pharma",
 * "top 10 IT companies"?
 *
 * Exposed so the surfaces can strengthen the FIRST system prompt instead of
 * detecting a bare list afterwards and paying for a second full agent loop.
 * Measured 2026-09-14: letting the retry handle it cost 6 LLM hops, 40 quote
 * requests and 30s wall clock, versus roughly half that when the instruction
 * rides along on the first call.
 */
export function isDiscoveryQuery(text) {
  return DISCOVERY_RE.test(String(text || ""));
}

export function looksLikePricelessList(replyText, userText) {
  const s = String(replyText || "").trim();
  if (!s) return false;
  // Any rupee figure or percentage means numbers were delivered. Not our case.
  if (/₹\s?[0-9]|[0-9]+(?:\.[0-9]+)?\s?%/.test(s)) return false;
  // Only applies when the user actually asked a discovery/screening question.
  // A concept answer that happens to mention tickers is not a failed lookup.
  if (!DISCOVERY_RE.test(String(userText || ""))) return false;
  // Instrument-shaped mentions, e.g. "HDFC Bank (HDFCBANK)". Three distinct
  // parenthesised tickers is a list; ordinary prose does not reach it.
  const m = s.match(/\(([A-Z][A-Z0-9&._-]{2,14})\)/g) || [];
  const tickers = new Set(m.map((t) => t.slice(1, -1)));
  return tickers.size >= 3;
}

export function isToolCallOnly(raw) {
  const s = String(raw || "").trim();
  if (!s) return false;
  if (stripToolCallScaffolding(s).trim()) return false;
  return /CALL\s+\w+|\[(?:tool|function)[ _]?call|tool_calls/i.test(s);
}

// ---------------------------------------------------------------------------
// ADVICE GUARD — code layer behind the persona's "never pick, never cheer"
// rules. Every pattern below comes from a real reply (13 Oct audit, C19-C21):
//   jan 10 Oct    "Mera suggestion hai ki Reliance ya SBI se shuru karo ...
//                  5-10 shares buy karke dekho"
//   zane_pro      "you could buy 100 shares of Tata Steel"
//   jessie        "a company you know—like Tata Motors or Reliance"
//                 "picking 2-3 companies from different sectors"
//   _hardik_720_  "A 'safe' bet for beginners is usually a Nifty 50 blue-chip"
//   yashraj       "kaafi sahi move tha", "profit book karna hamesha achha hota
//                  hai", "sahi time par entry li thi", "Agla target kaunsa
//                  stock hai?", "koi naya stock lene ka plan hai?"
//   sharma        "crashes are when the 'smart money' goes shopping for
//                  discounts"
//   shlokmulay    "Ready to make your first move?"
//   aarush        "Want to try buying your first stock ... like Zomato or Tata"
// The prompt rule alone did not hold, so offending SENTENCES are removed from
// the reply. Cheaper and more predictable than asking the model again.
// ---------------------------------------------------------------------------
const ADVICE_RULES = [
  { rule: "pick", re: /\b(?:mera|meri|my)\s+suggestion\b/i },
  { rule: "pick", re: /\b(?:se|say)\s+shuru\s+karo\b/i },
  { rule: "pick", re: /\b\d+\s*(?:-|–|to)\s*\d+\s+shares?\s+(?:buy|le|lo|kharid)/i },
  { rule: "pick", re: /\b(?:buy|kharido|kharid lo|le lo)\s+\d+\s+shares?\b/i },
  { rule: "pick", re: /\bpick(?:ing)?\s+\d\s*(?:-|–|to)\s*\d\s+(?:companies|stocks)\b/i },
  // "a company you know—like Tata Motors or Reliance" / "something you use
  // every day, like Zomato or Tata". Case-sensitive on the names so "a
  // sector like IT or Banking" (a clean reply) is left alone by the
  // company/stock/something anchor.
  { rule: "pick", re: /\b(?:compan(?:y|ies)|stocks?|something)\b[^.?!\n]{0,40}\blike\s+[A-Z][\w&.]*(?:\s+[A-Z][\w&.]*)?\s+or\s+[A-Z]/ },
  { rule: "pick", re: /\b(?:safe|best|good)["'”’]?\s+bet\b/i },
  { rule: "pick", re: /\b(?:great|good|best|perfect)\s+(?:place|stock|company|pick)\s+to\s+start\b/i },
  { rule: "judge", re: /\b(?:sahi|accha|achha|acha|great|smart|good|solid|perfect|bad|galat|wrong)\s+(?:move|time|entry|exit|decision|trade|call)\b/i },
  { rule: "judge", re: /\bprofit\s+book\s+karna\s+hamesha\b/i },
  { rule: "judge", re: /\bhamesha\s+(?:achha|accha|acha)\s+(?:hota|hai)\b/i },
  { rule: "nudge", re: /\b(?:agla|agli|next)\s+(?:target|stock|buy|trade)\b/i },
  { rule: "nudge", re: /\bnaya\s+stock\s+(?:lene|kharidne)\b/i },
  { rule: "nudge", re: /\bready\s+to\s+make\s+your\s+(?:first|next)\s+(?:move|trade)\b/i },
  { rule: "nudge", re: /\bwant\s+to\s+try\s+buying\s+your\s+first\b/i },
  { rule: "timing", re: /\bsmart\s+money\b/i },
  { rule: "timing", re: /\bshopping\s+for\s+discounts\b/i },
  { rule: "timing", re: /\bbuy\s+the\s+dip\b/i },
];

/** First advice rule the text breaks, or null. */
export function adviceViolation(text) {
  const s = String(text || "");
  for (const { rule, re } of ADVICE_RULES) if (re.test(s)) return rule;
  return null;
}

// Roman-script Hindi markers. Two or more = the message is Hinglish. "me" is
// left out on purpose: it is an English word too.
const HINGLISH_RE = /\b(?:hai|hain|kya|kaise|kaisa|maine|mujhe|batao|bata|kitne|kitna|karo|karu|kiya|kar|ke|ka|ki|mein|bhai|nahi|nahin|kyu|kyun|kab|abhi|yaar|accha|achha|tum|tumhe|tumne|mera|meri|hoga|tha|thi|wala|kaun|kaunsa|lekin|aur|bhi|ye|yeh|woh|hum)\b/gi;
export function looksHinglish(text) {
  const hits = String(text || "").match(HINGLISH_RE);
  return !!hits && hits.length >= 2;
}

/** User wrote Hinglish and the reply is (almost) pure English. */
export function replyLanguageMismatch(userText, replyText) {
  if (!looksHinglish(userText)) return false;
  const hits = String(replyText || "").match(HINGLISH_RE);
  return !hits || hits.length < 2;
}

/**
 * Remove sentences that break an advice rule. Returns { text, rules }: the
 * cleaned reply and the rules that fired. When too little survives, or the
 * closing question was the problem, a short reflective line is used instead,
 * in the user's language.
 */
export function scrubAdvice(text, userText = "") {
  const src = String(text || "");
  const rules = [];
  const hinglish = looksHinglish(userText) || looksHinglish(src);
  const lines = src.split("\n").map((line) => {
    if (!adviceViolation(line)) return line;
    // Split a prose line into sentences; keep the clean ones.
    const parts = line.split(/(?<=[.!?।])\s+/);
    const kept = parts.filter((p) => {
      const r = adviceViolation(p);
      if (r) rules.push(r);
      return !r;
    });
    return kept.join(" ");
  });
  if (!rules.length) return { text: src, rules };
  let out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const reflect = hinglish
    ? "Is trade ke peeche tumhara plan kya tha, aur kis baat pe tum sell ya hold karoge?"
    : "What was your plan behind this, and what would make you sell or hold?";
  const neutral = hinglish
    ? "Main tumhare liye stock ya quantity choose nahi karta. Chaho to main dikha sakta hoon log companies ko kaise compare karte hain: profit growth, P/E aur debt."
    : "I don't pick stocks or quantities for you. I can show you how people compare companies instead: profit growth, P/E and debt.";
  if (out.replace(/[*_#>\s-]/g, "").length < 40) return { text: rules.includes("pick") ? neutral : reflect, rules };
  // A removed closing question leaves the reply hanging: end on reflection.
  if (!/[?？]\s*$/.test(out) && (rules.includes("nudge") || rules.includes("judge"))) out += `\n\n${reflect}`;
  return { text: out, rules };
}
