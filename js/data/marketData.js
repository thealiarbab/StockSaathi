// =============================================================================
// MARKET DATA — brute-force reliable live quotes.
//
// Priority:
//   1. /api/quote?symbol=X           — normalized single-symbol endpoint
//   2. /api/quotes?symbols=A,B,C     — parallel batch endpoint (for lists)
//   3. Direct Yahoo (many browsers)  — if browser allows CORS
//   4. Public CORS proxies           — last resort
//   5. Synthetic baseline            — never fails; clearly marked "stale"
//
// All prices paise. TTL 8s (tight for live feel). Batch uses all 50+ symbols
// in parallel server-side for the Markets page.
// =============================================================================

import { getSeries as synthSeries, getPriceAt as synthPriceAt } from "./prices.js";
import { getInstrument } from "./universe.js";

// Hotfix68a: BSE-only stocks need ".BO" suffix when forwarded to Yahoo via
// /api/live-quote etc. The server's existing logic (`ticker = symbol if "."
// in symbol else f"{symbol}.NS"`) already trusts dot-suffixed symbols, so the
// client just appends .BO for BSE rows. NSE rows pass through bare. Returns
// null for unknown symbols so callers fall back to default.
function _wireSym(symbol) {
  const inst = getInstrument(symbol);
  if (!inst) return symbol;
  if (inst.exchange === "BSE" && !symbol.includes(".")) return `${symbol}.BO`;
  return symbol;
}
// Hotfix57a: dropped `import { getState } from "../state.js"` — it was
// unused (search showed only one false-positive in a comment) and was
// the only thing blocking state.js from importing from this module.
// state.js now imports getFreshCachedQuote here so getHoldingsValue +
// getPortfolioValue + getHoldingPLPaise + getHoldingPLPct all read live
// /api/live-quote prices first instead of falling through to the
// seeded stub-walk for any Tier-2 equity (inst.price=null) — fixing
// hero/invested-tile mismatches site-wide (report card, coach, admin).

const QUOTE_TTL_MS = 8_000;
const HISTORY_TTL_MS = 10 * 60_000;
// 7s, not 10s: the live-quote poll fires every 10s, so a 10s timeout would
// allow a stuck request to still be in flight when its successor launches —
// they pile up and share connections. 7s leaves a 3s gap so each tick is
// firmly resolved or aborted before the next one fires.
const FETCH_TIMEOUT_MS = 7_000;
// Keep each upstream batch safely under /api/live-quote's MAX_SYMBOLS=80 and
// /api/quotes's matching 60 cap. Callers can pass the entire universe and
// getQuoteBatch auto-chunks so no page needs its own waving logic.
const MAX_BATCH_SIZE = 60;
// Cap concurrent in-flight chunks. With 2700 symbols and 60-per-chunk that
// would otherwise fan out to 45 simultaneous fetches via Promise.all,
// saturating Chrome's 6-per-host limit and creating head-of-line blocking.
// 4 keeps the pipeline saturated without thrashing.
const MAX_CONCURRENT_CHUNKS = 4;
// Bumped v2 → v3: v2 had pre-split Reliance etc cached for up to 14 days; we
// evict the lot so nobody paints with 2024-era numbers after the SW refresh.
const QUOTE_PERSIST_KEY = "ss.quotes.v3";
const LEGACY_QUOTE_KEYS = ["ss.quotes.v2", "ss.quotes.v1"];
// 48 h — enough to paint over Fri→Mon weekend gaps, tight enough that the
// Reliance post-split story can't be hidden for weeks.
const PERSIST_MAX_AGE_MS = 48 * 60 * 60 * 1000;

const _quoteCache = new Map();
const _historyCache = new Map();
const _fundamentalsCache = new Map();
// Sidecar tracking last-access timestamp for every symbol in _quoteCache.
// persistSoon truncates localStorage to the hottest 200 symbols so the
// 800ms-debounced JSON.stringify doesn't choke at 2700 symbols (~600 KB
// per write blocking the main thread). _touchQuote bumps the timestamp on
// every cache write OR read of a symbol's quote.
const _quoteAccessTs = new Map();
const PERSIST_MAX_SYMBOLS = 200;
function _touchQuote(sym) { _quoteAccessTs.set(sym, Date.now()); }

// Per-symbol rolling buffer of {t, price} points built from live quotes as
// they arrive. Lets Markets-grid sparklines show the actual intraday move
// instead of a seeded year-long walk. Capped so memory stays bounded during
// long-lived sessions. INTRADAY_SYMBOLS_MAX caps distinct symbol keys (LRU
// eviction in _appendIntraday); INTRADAY_BUFFER_MAX caps points per symbol.
const _intradayBuffer = new Map();
const INTRADAY_SYMBOLS_MAX = 200;        // distinct symbols held — LRU evicts beyond
const INTRADAY_BUFFER_MAX = 200;         // points per symbol
const INTRADAY_MIN_POINTS = 6;

// ---------- localStorage cache so the page paints with REAL prices instantly
function loadPersistedQuotes() {
  // Nuke any legacy cache keys on boot — one-shot migration so users who
  // had stale "Reliance = ₹3,130" saved in ss.quotes.v2 never see it again.
  for (const k of LEGACY_QUOTE_KEYS) {
    try { localStorage.removeItem(k); } catch {}
  }
  try {
    const raw = localStorage.getItem(QUOTE_PERSIST_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    const now = Date.now();
    for (const [sym, entry] of Object.entries(obj)) {
      const data = entry?.data || entry;
      const savedAt = entry?.savedAt || data?.ts;
      if (!data || !savedAt) continue;
      if (now - savedAt > PERSIST_MAX_AGE_MS) continue;
      _quoteCache.set(sym, { data: { ...data, stale: true }, ts: savedAt });
    }
  } catch {}
}
loadPersistedQuotes();

let _persistTimer = null;
function persistSoon() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      // Truncate to the hottest PERSIST_MAX_SYMBOLS by last-access ts.
      // Symbols never touched fall back to ts=0 and sort to the bottom, so
      // they're naturally evicted when the universe is wide. This keeps
      // localStorage writes under ~50 KB regardless of universe size.
      const ranked = [];
      for (const sym of _quoteCache.keys()) {
        ranked.push([sym, _quoteAccessTs.get(sym) || 0]);
      }
      ranked.sort((a, b) => b[1] - a[1]);
      const keep = ranked.slice(0, PERSIST_MAX_SYMBOLS);
      const obj = {};
      const now = Date.now();
      for (const [sym] of keep) {
        const entry = _quoteCache.get(sym);
        if (entry?.data) obj[sym] = { data: entry.data, savedAt: now };
      }
      localStorage.setItem(QUOTE_PERSIST_KEY, JSON.stringify(obj));
    } catch {}
  }, 800);
}

// Synchronous read of whatever is already in memory (incl. localStorage-loaded
// stale entries). Used by pages to prefill their first render instantly.
export function getCachedQuotes(symbols) {
  const out = {};
  if (!symbols) return out;
  for (const s of symbols) {
    const c = _quoteCache.get(s);
    if (c?.data) out[s] = c.data;
  }
  return out;
}

// Like getCachedQuotes but ONLY returns quotes that aren't stale. Rules:
// - Market CLOSED: any cached quote is fine (yesterday's close is still
//   the current reference price for display).
// - Market OPEN: the cache entry must be fresher than `maxAgeMs` AND the
//   quote's own upstream-staleness flag must be false (data.stale).
// Pages use this when they'd rather flash a skeleton for a second than
// display a misleading stale price (stock detail, stocks grid cards).
export function getFreshCachedQuote(symbol, maxAgeMs = 30_000) {
  const c = _quoteCache.get(symbol);
  if (!c?.data) return null;
  const marketOpen = _isNseOpen(Date.now());
  if (!marketOpen) return c.data;                  // closed → cache IS truth
  if (Date.now() - c.ts > maxAgeMs) return null;   // fetched too long ago
  if (c.data.stale) return null;                   // upstream feed lagged
  return c.data;
}
export function getFreshCachedQuotes(symbols, maxAgeMs = 30_000) {
  const out = {};
  if (!symbols) return out;
  for (const s of symbols) {
    const q = getFreshCachedQuote(s, maxAgeMs);
    if (q) out[s] = q;
  }
  return out;
}

export function getDataSource() {
  // Branded "NSE" — the underlying upstream (Yahoo / Finnhub) is sourcing
  // NSE tick data itself, and the user only cares that the numbers reflect
  // NSE. Calling it "Yahoo Finance" was technically accurate but confusing.
  return { name: "NSE", tier: "public" };
}

function normalizeFromApi(payload, symbol) {
  if (!payload?.ok) return null;
  const ts = payload.ts_ms || Date.now();
  // Staleness detection. Yahoo's free NSE feed is officially 15 min delayed
  // but in practice can fall hours behind during busy sessions. If the
  // quote's own timestamp is more than 90 s old DURING MARKET HOURS, flip
  // the "LIVE" badge to "DELAYED" so we don't lie to users. Outside market
  // hours the old timestamp is expected (market is closed).
  //
  // Hotfix66b: was 5 min — too generous. User's mum reported ₹5-20 drift
  // vs Groww. A 4m59s-old quote rendered as fresh "LIVE" while really
  // being nearly 5 min behind. 90 s is tight enough that any real lag
  // surfaces as a DELAYED chip, but loose enough that ordinary network
  // jitter doesn't constantly false-flag.
  const marketOpenNow = _isNseOpen(Date.now());
  const ageMinutes = (Date.now() - ts) / 60000;
  const stale = marketOpenNow && ageMinutes > 1.5;
  const pricePaise = Math.round(payload.price * 100);
  _appendIntraday(symbol, ts, pricePaise);
  return {
    symbol,
    pricePaise,
    prevClosePaise: Math.round(payload.prev_close * 100),
    changePct: payload.change_pct ?? 0,
    high: Math.round(payload.day_high * 100),
    low: Math.round(payload.day_low * 100),
    volume: payload.volume || 0,
    currency: payload.currency || "INR",
    ts,
    stale,
    staleAgeMinutes: stale ? Math.round(ageMinutes) : 0,
    source: payload.source || "yahoo",
  };
}

function _appendIntraday(symbol, ts, pricePaise) {
  if (!Number.isFinite(pricePaise)) return;
  let buf = _intradayBuffer.get(symbol);
  if (buf) {
    // Touch: re-insert moves the symbol to the tail of insertion order so
    // the head is always the least-recently-touched (LRU eviction target).
    _intradayBuffer.delete(symbol);
    _intradayBuffer.set(symbol, buf);
  } else {
    buf = [];
    _intradayBuffer.set(symbol, buf);
    // Evict the least-recently-touched buffer once we exceed the symbol cap.
    // At ~50 KB per filled buffer × 200 cap = ~10 MB resident, vs ~135 MB if
    // 2700 symbols all populated. Caps memory across long-lived sessions.
    if (_intradayBuffer.size > INTRADAY_SYMBOLS_MAX) {
      const oldest = _intradayBuffer.keys().next().value;
      if (oldest !== undefined) _intradayBuffer.delete(oldest);
    }
  }
  // De-dupe consecutive identical prices — no visual value in recording the
  // same close twice, and Yahoo sometimes repeats between ticks.
  const last = buf[buf.length - 1];
  if (last && last.t === ts) return;
  if (last && last.price === pricePaise && ts - last.t < 30_000) return;
  buf.push({ t: ts, price: pricePaise });
  if (buf.length > INTRADAY_BUFFER_MAX) buf.splice(0, buf.length - INTRADAY_BUFFER_MAX);
}

// Returns an array of close prices sourced from the live intraday buffer
// if it has grown enough points, otherwise falls back to the seeded walk
// so cold page loads still render. Used by the Markets grid sparklines.
export function getIntradaySparkline(symbol, fallbackCloses) {
  const buf = _intradayBuffer.get(symbol);
  if (buf && buf.length >= INTRADAY_MIN_POINTS) return buf.map(p => p.price);
  return fallbackCloses;
}

function _isNseOpen(nowMs) {
  // Cheap + correct: use Intl for Asia/Kolkata, mirror prices.js marketStatus.
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", weekday: "short",
      hour12: false,
    }).formatToParts(new Date(nowMs)).reduce((a, p) => (a[p.type] = p.value, a), {});
    const mins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
    const weekday = (parts.weekday || "").toLowerCase();
    if (["sat", "sun"].includes(weekday)) return false;
    return mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
  } catch { return false; }
}

// ---------- Public API -----------------------------------------------------

export async function getQuote(symbol, opts = {}) {
  const bustCache = opts.bustCache === true;
  if (!bustCache) {
    const cached = _quoteCache.get(symbol);
    if (cached && Date.now() - cached.ts < QUOTE_TTL_MS) return cached.data;
  }

  const inst = getInstrument(symbol);
  if (!inst) return null;

  // MFs have no real-time feed — synthetic
  if (inst.kind === "MF") {
    const q = synthMFQuote(symbol, inst);
    _quoteCache.set(symbol, { data: q, ts: Date.now() });
    return q;
  }

  // 1. New normalized single endpoint. Append nocache=1 when bustCache
  // is requested so the SERVER also bypasses its own cache (and Vercel
  // edge cache via the no-store header the server adds when it sees
  // nocache=1) — otherwise the server might hand back its own cached
  // value that's still seconds old.
  // Hotfix68a: route BSE-only symbols via .BO suffix.
  const wireSym = _wireSym(symbol);
  const qs = bustCache ? `?symbol=${encodeURIComponent(wireSym)}&nocache=1&_=${Date.now()}` : `?symbol=${encodeURIComponent(wireSym)}`;
  const apiRes = await fetchJsonWithTimeout(`/api/quote${qs}`);
  const apiQuote = normalizeFromApi(apiRes, symbol);
  if (apiQuote) {
    _quoteCache.set(symbol, { data: apiQuote, ts: Date.now() });
    _touchQuote(symbol);
    persistSoon();
    return apiQuote;
  }

  // 2. Legacy path through /api/yahoo/chart
  const fallback = await fetchYahooQuote(symbol).catch(() => null);
  if (fallback) {
    _quoteCache.set(symbol, { data: fallback, ts: Date.now() });
    _touchQuote(symbol);
    persistSoon();
    return fallback;
  }

  // 3. Synthetic last resort — marked stale so UI can flag it
  const synth = synthQuote(symbol);
  _quoteCache.set(symbol, { data: synth, ts: Date.now() });
  _touchQuote(symbol);
  return synth;
}

export async function getQuoteBatch(symbols) {
  if (!symbols?.length) return {};
  const uniq = [...new Set(symbols)];

  // Auto-chunk when callers pass more than one upstream's worth of symbols.
  // Cap concurrency so a 2700-symbol fan-out doesn't burst 45 simultaneous
  // fetch() calls and starve the browser's per-host connection pool. 4 in
  // flight keeps the pipeline saturated without head-of-line blocking.
  if (uniq.length > MAX_BATCH_SIZE) {
    const chunks = [];
    for (let i = 0; i < uniq.length; i += MAX_BATCH_SIZE) {
      chunks.push(uniq.slice(i, i + MAX_BATCH_SIZE));
    }
    const results = await _runWithLimit(chunks, MAX_CONCURRENT_CHUNKS, c => _getQuoteBatchInner(c));
    return Object.assign({}, ...results);
  }
  return _getQuoteBatchInner(uniq);
}

// Tiny p-limit-style runner: starts up to `limit` workers, each pulls the
// next item until exhausted. Preserves input order in the result array.
async function _runWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function pump() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (e) { results[i] = {}; }   // swallow chunk failure, neighbours survive
    }
  }
  const workers = [];
  for (let k = 0; k < Math.min(limit, items.length); k++) workers.push(pump());
  await Promise.all(workers);
  return results;
}

async function _getQuoteBatchInner(uniq) {
  const out = {};

  // Try the new cache-first /api/live-quote endpoint. Hundreds of users
  // polling the same symbols share one upstream Yahoo/Dhan hit per 10s
  // via Supabase quote_cache. Falls through to /api/quotes on failure so
  // this is safe to ship before the quote_cache table is created.
  const liveTargets = uniq.filter(s => {
    const inst = getInstrument(s);
    return inst && inst.kind !== "MF";
  });
  if (liveTargets.length) {
    // Hotfix68a: wire-form per symbol (.BO for BSE-only). Build a map back
    // to our internal symbol so the response keyed on the wire symbol can
    // be reconciled to our cache (which uses the unsuffixed symbol).
    const wireToOurs = {};
    const wireSyms = liveTargets.map(s => {
      const w = _wireSym(s);
      wireToOurs[w] = s;
      return w;
    });
    const liveUrl = `/api/live-quote?symbols=${encodeURIComponent(wireSyms.join(","))}`;
    const live = await fetchJsonWithTimeout(liveUrl).catch(() => null);
    if (live?.ok && live.quotes) {
      let any = false;
      for (const w of wireSyms) {
        const q = live.quotes[w];
        if (q) {
          const ourSym = wireToOurs[w];
          const norm = normalizeFromApi({ ok: true, ...q }, ourSym);
          if (norm) {
            out[ourSym] = norm;
            _quoteCache.set(ourSym, { data: norm, ts: Date.now() });
            _touchQuote(ourSym);
            any = true;
          }
        }
      }
      if (any) persistSoon();
    }
  }

  const need = [];

  // Serve from cache first
  for (const s of uniq) {
    const c = _quoteCache.get(s);
    if (c && Date.now() - c.ts < QUOTE_TTL_MS) { out[s] = c.data; _touchQuote(s); }
    else need.push(s);
  }
  if (!need.length) return out;

  // Try batch endpoint — fetches all missing symbols in parallel server-side
  // Hotfix68a: same .BO wire mapping for the legacy /api/quotes path.
  const batchWireToOurs = {};
  const batchWireSyms = need.map(s => {
    const w = _wireSym(s);
    batchWireToOurs[w] = s;
    return w;
  });
  const batchUrl = `/api/quotes?symbols=${encodeURIComponent(batchWireSyms.join(","))}`;
  const batch = await fetchJsonWithTimeout(batchUrl);
  if (batch?.ok && batch.quotes) {
    let any = false;
    for (const w of batchWireSyms) {
      const s = batchWireToOurs[w];
      const q = batch.quotes[w];
      if (q) {
        const norm = normalizeFromApi({ ok: true, ...q }, s);
        if (norm) {
          out[s] = norm;
          _quoteCache.set(s, { data: norm, ts: Date.now() });
          _touchQuote(s);
          any = true;
        }
      }
    }
    if (any) persistSoon();
  }

  // Fill any remaining misses one by one (usually empty)
  const missing = need.filter(s => !out[s]);
  if (missing.length) {
    const results = await Promise.all(missing.map(s => getQuote(s).catch(() => null)));
    for (let i = 0; i < missing.length; i++) {
      if (results[i]) out[missing[i]] = results[i];
    }
  }
  return out;
}

export async function getHistory(symbol, range = "1y", interval = "1d", opts = {}) {
  // Hotfix48a: custom date-range support. Caller can pass opts.from /
  // opts.to as YYYY-MM-DD strings; the API receives them and returns the
  // exact window. Cache key includes the custom range so different
  // custom queries don't share cache.
  const customKey = (opts.from && opts.to) ? `|${opts.from}|${opts.to}` : "";
  const key = `${symbol}|${range}|${interval}${customKey}`;
  // Caller-provided AbortSignal (from the stockDetail live-refresh path).
  // When set, any in-flight fetch aborts cleanly and the function throws
  // an AbortError so the caller can drop the result. Cached hits still
  // return synchronously regardless of signal state — no point aborting
  // a zero-cost lookup. Cache bypass is explicit via opts.noCache.
  const sig = opts.signal || null;
  if (!opts.noCache) {
    const cached = _historyCache.get(key);
    if (cached && Date.now() - cached.ts < HISTORY_TTL_MS) return cached.data;
  }
  if (sig?.aborted) {
    const err = new Error("aborted"); err.name = "AbortError"; throw err;
  }
  const inst = getInstrument(symbol);
  if (!inst) return { ohlc: [], source: "none" };

  // MFs have no Yahoo coverage (MF_<amfi_code>.NS isn't a valid ticker).
  // The synthHistory fallback would silently use the seeded stub walk and
  // serve up garbage as "history". Caller (stockDetail.js MF branch) is
  // expected to use getMfHistory() directly. Returning empty here makes
  // any accidental cross-call fail-fast with a visible empty chart instead
  // of a misleading random walk.
  if (inst.kind === "MF") {
    const empty = { ohlc: [], source: "mf-no-yahoo" };
    _historyCache.set(key, { data: empty, ts: Date.now() });
    return empty;
  }

  let h = null;
  if (inst.kind === "EQUITY" || inst.kind === "ETF") {
    // Preferred: dedicated /api/history endpoint (reliable, returns paise).
    // Falls through to legacy fetchYahooHistory → synthHistory on failure.
    try {
      // Hotfix48a: when opts.from + opts.to provided, request a custom
      // date window via from/to params (server uses period1/period2).
      const customQs = (opts.from && opts.to)
        ? `&from=${encodeURIComponent(opts.from)}&to=${encodeURIComponent(opts.to)}`
        : "";
      // Hotfix68a: route BSE-only symbols via .BO suffix.
      const wireHist = _wireSym(symbol);
      const res = await fetchJsonWithTimeout(
        `/api/history?symbol=${encodeURIComponent(wireHist)}&range=${range}&interval=${interval}${customQs}`,
        { signal: sig }
      );
      if (sig?.aborted) {
        const err = new Error("aborted"); err.name = "AbortError"; throw err;
      }
      if (res?.ok && Array.isArray(res.ohlc) && res.ohlc.length) {
        h = { ohlc: res.ohlc, source: "yahoo", host: res.host };
      }
    } catch (e) {
      if (e?.name === "AbortError") throw e;
    }
    if (!h) {
      h = await fetchYahooHistory(symbol, range, interval, { signal: sig }).catch((e) => {
        if (e?.name === "AbortError") throw e;
        return null;
      });
      if (sig?.aborted) {
        const err = new Error("aborted"); err.name = "AbortError"; throw err;
      }
    }
  }
  if (!h) h = synthHistory(symbol);
  _historyCache.set(key, { data: h, ts: Date.now() });
  return h;
}

// ---------- MF NAV history (mfapi.in via /api/mf-history) ------------------
//
// Returns the same shape as getHistory(): { ohlc, source } so callers
// can use it interchangeably. Values are in PAISE (matches /api/history).
//
// tf values mirror the UI TF_MAP keys: "1M", "3M", "6M", "1Y", "3Y", "5Y".
// "1D" and "1W" are not meaningful for NAV history (NAVs publish once per
// day with no intraday candles), so they're remapped to "1M" so the chart
// always renders something useful.
//
// In-memory cache: 1 hour. Falls back to { ohlc: [], source: "none" } on
// network error so the chart shows the loading skeleton rather than crashing.

const MF_HISTORY_TTL_MS = 60 * 60_000;
const _mfHistoryCache = new Map();
// Hotfix47b/51c: timeframe remap for the MF API. mfapi.in accepts {1M,
// 3M, 6M, 1Y, 3Y, 5Y, ALL}. Frontend names map as below.
//   1D, 1W   â†’ 1M (MF NAV is daily; sub-day not meaningful)
//   YTD      â†’ 5Y (fetch a wider window then slice from Jan 1 client-
//                  side â€” see _sliceYtd in getMfHistory). 5Y is enough
//                  to cover any realistic YTD even for funds launched
//                  in the past 12 months.
//   MAX      â†’ ALL (full AMFI history for the scheme)
//   5Y, 1M, 3M, 6M, 1Y pass through unchanged
const _MF_TF_REMAP = { "1D": "1M", "1W": "1M", "YTD": "5Y", "MAX": "ALL" };

// Slice an OHLC array to entries from Jan 1 of the current year onward.
// Used by getMfHistory's YTD path so the chart shows actual year-to-date
// instead of the past 12 months. Stock equivalent: /api/history's native
// `range=ytd` already does this server-side; mfapi.in doesn't support
// YTD so we slice client-side from a wider series.
function _sliceYtd(ohlc) {
  if (!Array.isArray(ohlc) || ohlc.length === 0) return ohlc;
  const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
  return ohlc.filter(k => k && typeof k.t === "number" && k.t >= yearStart);
}

export async function getMfHistory(symbol, tf = "1Y") {
  const mappedTf = _MF_TF_REMAP[tf] || tf;
  const key = `${symbol}|${mappedTf}`;

  const cached = _mfHistoryCache.get(key);
  if (cached && Date.now() - cached.ts < MF_HISTORY_TTL_MS) return cached.data;

  // "MF_118718" → "118718". Reject anything that doesn't look like an
  // AMFI scheme code so we don't burn an upstream call we know will fail.
  const amfiCode = symbol && symbol.startsWith("MF_") ? symbol.slice(3) : symbol;
  if (!amfiCode || !/^\d{1,6}$/.test(amfiCode)) {
    return { ohlc: [], source: "none" };
  }

  let result = null;
  try {
    const res = await fetchJsonWithTimeout(
      `/api/mf-history?code=${encodeURIComponent(amfiCode)}&tf=${encodeURIComponent(mappedTf)}`
    );
    if (res?.ok && Array.isArray(res.ohlc) && res.ohlc.length) {
      result = {
        ohlc:        res.ohlc,
        source:      "mfapi",
        scheme_name: res.scheme_name || "",
        fund_house:  res.fund_house  || "",
        asof_date:   res.asof_date   || "",
        latest_nav_paise: res.latest_nav_paise ?? null,
      };
    }
  } catch (_) {
    // Network failure or timeout → fall through to empty fallback.
  }

  if (!result) result = { ohlc: [], source: "none" };
  // Hotfix51c: client-side YTD slice. The cached result keeps the wider
  // 5Y data so other timeframes that share the cache don't re-fetch,
  // but the YTD-specific cache key gets a sliced ohlc array.
  if (tf === "YTD" && result.ohlc?.length) {
    result = { ...result, ohlc: _sliceYtd(result.ohlc) };
  }
  _mfHistoryCache.set(key, { data: result, ts: Date.now() });
  return result;
}

// ---------- Live polling ---------------------------------------------------

// Accepts EITHER a fixed symbols array (legacy callers like portfolio.js and
// stockDetail.js) OR a () => string[] callback (Markets grid: viewport-only
// set). The callback is invoked at the start of every tick so the polled
// set tracks scroll/filter changes without re-subscribing. Returning an
// empty list is fine — it just skips the tick.
//
// Behaviours layered on top:
//   * document.hidden gate — ticks skipped while tab is in background; one
//     tick fires immediately on visibilitychange so users coming back don't
//     stare at stale numbers.
//   * Inflight guard — if a previous getQuoteBatch is still pending when
//     interval fires, skip rather than stack (compounds under slow networks).
//   * AbortError-aware — never crashes the polling loop on a network blip.
export function subscribeToQuotes(symbols, onUpdate, intervalMs = 10_000) {
  const isCallback = typeof symbols === "function";
  if (!isCallback && !symbols?.length) return () => {};

  let cancelled = false;
  let inflight = null;
  let timer = null;

  function currentSymbols() {
    if (isCallback) {
      try {
        const out = symbols() || [];
        return Array.isArray(out) ? out : [];
      } catch { return []; }
    }
    return symbols;
  }

  async function tick() {
    if (cancelled) return;
    if (typeof document !== "undefined" && document.hidden) return;
    if (inflight) return;
    const syms = currentSymbols();
    if (!syms.length) return;
    const p = (async () => {
      try {
        const quotes = await getQuoteBatch(syms);
        if (!cancelled) onUpdate(quotes);
      } catch (e) {
        if (e?.name !== "AbortError") console.warn("[poll]", e?.message || e);
      }
    })();
    inflight = p;
    try { await p; } finally {
      if (inflight === p) inflight = null;
    }
  }

  function onVisibility() {
    if (cancelled) return;
    if (!document.hidden) tick();
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  tick();
  timer = setInterval(tick, intervalMs);
  return () => {
    cancelled = true;
    if (timer) clearInterval(timer);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

export function quoteAge(quote) {
  if (!quote?.ts) return null;
  return Date.now() - quote.ts;
}

// =============================================================================
// FUNDAMENTALS — real values via /api/fundamentals (Yahoo v7/quote backed)
// Cached 5 min in memory. Fundamentals barely change intraday.
// =============================================================================
const FUND_TTL_MS = 5 * 60_000;

export async function getFundamentals(symbol) {
  const cached = _fundamentalsCache.get(symbol);
  if (cached && Date.now() - cached.ts < FUND_TTL_MS) return cached.data;
  // Hotfix68a: route BSE-only symbols via .BO suffix.
  const res = await fetchJsonWithTimeout(`/api/fundamentals?symbol=${encodeURIComponent(_wireSym(symbol))}`);
  if (res?.ok) {
    _fundamentalsCache.set(symbol, { data: res, ts: Date.now() });
    return res;
  }
  return null;
}

// ---------- Legacy Yahoo proxy chain (kept as fallback) --------------------

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
function yahooTicker(sym) { return sym.includes(".") ? sym : `${sym}.NS`; }

async function fetchYahooUrl(yahooUrl, opts = {}) {
  const sig = opts.signal || null;
  // Direct first (works in some browsers / same-origin proxies)
  let res = await fetchJsonWithTimeout(yahooUrl, { signal: sig });
  if (sig?.aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
  if (res) return res;
  // Public CORS proxies as last resort
  const p1 = `https://corsproxy.io/?url=${encodeURIComponent(yahooUrl)}`;
  res = await fetchJsonWithTimeout(p1, { signal: sig });
  if (sig?.aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
  if (res) return res;
  const p2 = `https://api.allorigins.win/get?url=${encodeURIComponent(yahooUrl)}`;
  const w = await fetchJsonWithTimeout(p2, { signal: sig });
  if (sig?.aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
  if (w?.contents) { try { return JSON.parse(w.contents); } catch {} }
  return null;
}

async function fetchYahooQuote(symbol) {
  const url = `${YAHOO_BASE}/${encodeURIComponent(yahooTicker(symbol))}?interval=1d&range=5d`;
  const data = await fetchYahooUrl(url);
  const r = data?.chart?.result?.[0];
  if (!r) return null;
  let meta = r.meta || {};
  // Yahoo mislabels some NSE SME listings as MUTUALFUND and freezes their
  // meta.regularMarketPrice at 2024-07-23 while the bars keep trading
  // (AILIMITED: meta Rs 94, real Rs 15.60). Believe the newest bar when it is
  // more than 3 days newer than the meta price. Mirrors handlers/_yahoo_price.py.
  let price = meta.regularMarketPrice;
  const stamps = r.timestamp || [];
  const closes = r.indicators?.quote?.[0]?.close || [];
  let lastIdx = -1;
  for (let i = Math.min(stamps.length, closes.length) - 1; i >= 0; i--) {
    if (closes[i] != null) { lastIdx = i; break; }
  }
  if (lastIdx >= 0 && (price == null
      || (meta.regularMarketTime && stamps[lastIdx] - meta.regularMarketTime > 3 * 86400))) {
    let prev = null;
    for (let i = lastIdx - 1; i >= 0; i--) { if (closes[i] != null) { prev = closes[i]; break; } }
    price = closes[lastIdx];
    meta = { chartPreviousClose: prev, regularMarketTime: stamps[lastIdx], currency: meta.currency };
  }
  const prevClose = meta.chartPreviousClose || meta.previousClose || price;
  if (price == null) return null;
  return {
    symbol,
    pricePaise: Math.round(price * 100),
    prevClosePaise: Math.round(prevClose * 100),
    changePct: prevClose ? (price - prevClose) / prevClose : 0,
    high: Math.round((meta.regularMarketDayHigh || price) * 100),
    low: Math.round((meta.regularMarketDayLow || price) * 100),
    volume: meta.regularMarketVolume || 0,
    currency: meta.currency || "INR",
    ts: (meta.regularMarketTime || Math.floor(Date.now() / 1000)) * 1000,
    stale: false,
    source: "yahoo",
  };
}

async function fetchYahooHistory(symbol, range, interval, opts = {}) {
  const url = `${YAHOO_BASE}/${encodeURIComponent(yahooTicker(symbol))}?interval=${interval}&range=${range}`;
  const data = await fetchYahooUrl(url, { signal: opts.signal });
  const r = data?.chart?.result?.[0];
  if (!r) return null;
  const timestamps = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const ohlc = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = q.close?.[i], o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], v = q.volume?.[i];
    if (c == null || o == null || h == null || l == null) continue;
    ohlc.push({
      t: timestamps[i] * 1000,
      o: Math.round(o * 100), h: Math.round(h * 100),
      l: Math.round(l * 100), c: Math.round(c * 100),
      v: v || 0,
    });
  }
  if (!ohlc.length) return null;
  return { ohlc, source: "yahoo" };
}

function synthMFQuote(symbol, inst) {
  // Hotfix54: Hotfix51b correctly switched basePaise from inst.price to
  // inst.nav*100, but kept the random drift formula from when this
  // function was used as a poor man's intraday simulator. That drift
  // had no business being applied to MF NAVs â€” AMFI publishes one
  // NAV per scheme per day, end-of-session, period. The 12-second
  // poll then bounced the header price by Â±0.2% every tick (user-
  // reported screenshots showed Rs.11.17 -> Rs.11.18 -> Rs.11.19 in
  // 4 seconds on a static fund), producing fake change% numbers.
  // Now: return the actual NAV. Day-over-day change comes from the
  // mfHistory cache when available (last two closes), else 0%.
  const basePaise = (typeof inst.nav === "number" && inst.nav > 0)
    ? Math.round(inst.nav * 100)
    : inst.price;
  if (!basePaise || basePaise <= 0) return null;
  // Best-effort prev-close lookup from the warm mfHistory cache. Any
  // recent timeframe will do (1M / 1Y / etc.) since they all share the
  // same series prefix â€” we just want the second-to-last entry's close.
  // No fetch here; if the cache is cold (first load before chart fires)
  // we report 0% change and the next render after the chart loads will
  // pick up the real change% via the cache hit.
  let prevPaise = basePaise;
  let changePct = 0;
  for (const [key, entry] of _mfHistoryCache) {
    if (!key.startsWith(symbol + "|")) continue;
    const ohlc = entry?.data?.ohlc;
    if (Array.isArray(ohlc) && ohlc.length >= 2) {
      const prev = ohlc[ohlc.length - 2];
      if (prev && typeof prev.c === "number" && prev.c > 0) {
        prevPaise = prev.c;
        changePct = (basePaise - prevPaise) / prevPaise;
        break;
      }
    }
  }
  return {
    symbol,
    pricePaise: basePaise,
    prevClosePaise: prevPaise,
    changePct,
    high: basePaise,
    low: basePaise,
    volume: 0,
    currency: "INR",
    ts: Date.now(),
    stale: false,
    source: "mf-static",
  };
}

function synthQuote(symbol) {
  const cur = synthPriceAt(symbol, 0);
  const prev = synthPriceAt(symbol, 1) || cur;
  if (!cur) return null;
  return {
    symbol, pricePaise: cur, prevClosePaise: prev,
    changePct: prev ? (cur - prev) / prev : 0,
    high: Math.round(cur * 1.005), low: Math.round(cur * 0.995),
    volume: 0, currency: "INR", ts: Date.now(),
    stale: true, source: "synthetic",
  };
}
function synthHistory(symbol) { return { ohlc: synthSeries(symbol), source: "synthetic" }; }

function fetchJsonWithTimeout(url, options = {}) {
  // Honour a caller-provided AbortSignal in addition to the internal timeout.
  // If the caller's signal fires first, we reject with AbortError so callers
  // (e.g. stockDetail.refreshHistory) can distinguish "user left the page /
  // switched timeframe" from "network failed". If the timeout fires first,
  // we resolve to null — same silent-degrade behaviour the rest of this
  // module relies on for best-effort quote refreshes.
  const external = options.signal || null;
  // If the external signal is already aborted, short-circuit.
  if (external?.aborted) {
    return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  }
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let externalAborted = false;
    const onExternalAbort = () => {
      externalAborted = true;
      clearTimeout(t);
      try { ctrl.abort(); } catch {}
      if (external) external.removeEventListener("abort", onExternalAbort);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    if (external) external.addEventListener("abort", onExternalAbort, { once: true });
    // Build a fetch-safe options bag: drop our `signal` key so we control it.
    const fetchOpts = { ...options };
    delete fetchOpts.signal;
    fetch(url, { ...fetchOpts, signal: ctrl.signal, cache: "no-store" })
      .then(r => {
        clearTimeout(t);
        if (external) external.removeEventListener("abort", onExternalAbort);
        if (externalAborted) return;
        if (!r.ok) { resolve(null); return; }
        return r.json();
      })
      .then(j => { if (!externalAborted) resolve(j || null); })
      .catch(() => {
        clearTimeout(t);
        if (external) external.removeEventListener("abort", onExternalAbort);
        if (externalAborted) return;   // reject already fired
        resolve(null);
      });
  });
}
