"""GET /api/fundamentals?symbol=RELIANCE — real fundamentals, 4-tier chain.

Tier 0 — Supabase fundamentals_cache table (24h TTL, populated by daily cron
         /api/admin-sync-fundamentals). Hot path.
Tier 1 — Yahoo /v7/finance/quote   (crumb-authed via _yahoo_session.py)
Tier 2 — Yahoo /v10/finance/quoteSummary (crumb-authed)
Tier 3 — Tickertape unofficial API (api.tickertape.in) — full ratios fallback
Tier 4 — Yahoo /v8/finance/chart   (anonymous, only 52W + price)

Any tier with non-null fields is merged in; tier 1 wins for fields it has,
tier 2 fills gaps, etc. Verified live 2026-04-25:
  RELIANCE → marketCap, PE, PB, beta, divYield, sector all populated.
  ADFFOODS → same (Tickertape covers when Yahoo doesn't).
"""

import os
import re
import sys
import json
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote as url_quote

# Vercel's @vercel/python runtime doesn't always include the handler's own
# directory on sys.path at import time, so sibling underscore-helpers like
# _yahoo_session.py + _tickertape.py fail to import unless we add it
# explicitly. Confirmed via /api/debug-fundamentals: tiers work when called
# from a handler that does sys.path.insert; silently fail otherwise.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# ── Yahoo crumb session + Tickertape wrapper (sibling modules) ───────────────
# Tolerate import failure on cold deploy edge cases — fall back to legacy
# anonymous fetches if either helper isn't on disk.
try:
    from _yahoo_session import fetch_with_crumb as _yahoo_authed_fetch
except Exception:
    _yahoo_authed_fetch = None
try:
    from _tickertape import fetch_ratios as _tickertape_fetch
except Exception:
    _tickertape_fetch = None


UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
      "AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/131.0.0.0 Safari/537.36")

V8_HOSTS = [
    "https://query1.finance.yahoo.com/v8/finance/chart",
    "https://query2.finance.yahoo.com/v8/finance/chart",
]

_SYMBOL_RE = re.compile(r"^[A-Z0-9.\-\^=_&]{1,24}$")

# ── Supabase config (used for the cache tier) ───────────────────────────────
SUPA_URL  = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_ANON = os.environ.get("SUPABASE_ANON_KEY", "").strip()
SUPA_SRV  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
SUPA_KEY_READ  = SUPA_ANON or SUPA_SRV
SUPA_KEY_WRITE = SUPA_SRV  # writes need service role; readers use anon (RLS-safe)

CACHE_TTL_MS = int(os.environ.get("FUNDAMENTALS_CACHE_TTL_MS", str(24 * 60 * 60 * 1000)))


def _yahoo_anon_fetch(url, timeout=6):
    """Anonymous fetch (no crumb). Used by tier 4 (v8/chart) which doesn't
    require a crumb, and as a last-ditch fallback for v7/v10 if the crumb
    helper is unavailable."""
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None


# ── Tier 0: Supabase cache ──────────────────────────────────────────────────
def read_cache(symbol):
    """Returns the cached row dict if fresh (< CACHE_TTL_MS old), else None."""
    if not (SUPA_URL and SUPA_KEY_READ):
        return None
    url = (f"{SUPA_URL}/rest/v1/fundamentals_cache"
           f"?symbol=eq.{url_quote(symbol)}&select=*")
    headers = {
        "apikey": SUPA_KEY_READ,
        "Authorization": f"Bearer {SUPA_KEY_READ}",
        "Accept": "application/json",
    }
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=3) as r:
            rows = json.loads(r.read())
        if not rows:
            return None
        row = rows[0]
        cached_at = row.get("cached_at_ms") or 0
        if (int(time.time() * 1000) - cached_at) > CACHE_TTL_MS:
            return None   # stale; will refresh from upstream and re-write
        return {
            "name":               row.get("name"),
            "sector":             row.get("sector"),
            "industry":           row.get("industry"),
            "market_cap":         _to_float(row.get("market_cap")),
            "pe_ratio":           _to_float(row.get("pe_ratio")),
            "pe_ttm":             _to_float(row.get("pe_ttm")),
            "pb_ratio":           _to_float(row.get("pb_ratio")),
            "beta":               _to_float(row.get("beta")),
            "dividend_yield":     _to_float(row.get("dividend_yield")),
            "eps":                _to_float(row.get("eps")),
            "roe":                _to_float(row.get("roe")),
            "debt_to_equity":     _to_float(row.get("debt_to_equity")),
            "fifty_two_week_high": _to_float(row.get("fifty_two_week_high")),
            "fifty_two_week_low":  _to_float(row.get("fifty_two_week_low")),
            "fifty_day_average":  _to_float(row.get("fifty_day_avg")),
            "two_hundred_day_average": _to_float(row.get("two_hundred_day_avg")),
            "currency":           "INR",
            "source_tiers":       ["cache"],
            "cached_at_ms":       cached_at,
        }
    except Exception:
        return None


def write_cache(symbol, data):
    """Upsert a fresh fundamentals row. Called by /api/admin-sync-fundamentals
    after a successful upstream fetch. Best-effort — failure is silent (the
    in-memory result still serves the request)."""
    if not (SUPA_URL and SUPA_KEY_WRITE) or not data:
        return False
    row = {
        "symbol":               symbol,
        "name":                 data.get("name"),
        "sector":               data.get("sector"),
        "industry":             data.get("industry"),
        "market_cap":           _to_float(data.get("market_cap")),
        "pe_ratio":             _to_float(data.get("pe_ratio")),
        "pe_ttm":               _to_float(data.get("pe_ttm")),
        "pb_ratio":             _to_float(data.get("pb_ratio")),
        "beta":                 _to_float(data.get("beta")),
        "dividend_yield":       _to_float(data.get("dividend_yield")),
        "eps":                  _to_float(data.get("eps")),
        "roe":                  _to_float(data.get("roe")),
        "debt_to_equity":       _to_float(data.get("debt_to_equity")),
        "fifty_two_week_high":  _to_float(data.get("fifty_two_week_high")),
        "fifty_two_week_low":   _to_float(data.get("fifty_two_week_low")),
        "fifty_day_avg":        _to_float(data.get("fifty_day_average")),
        "two_hundred_day_avg":  _to_float(data.get("two_hundred_day_average")),
        "source":               "+".join(data.get("source_tiers") or []),
        "cached_at_ms":         int(time.time() * 1000),
    }
    body = json.dumps(row).encode("utf-8")
    url = f"{SUPA_URL}/rest/v1/fundamentals_cache"
    headers = {
        "apikey": SUPA_KEY_WRITE,
        "Authorization": f"Bearer {SUPA_KEY_WRITE}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    try:
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=4) as r:
            r.read()
        return True
    except Exception:
        return False


def _to_float(v):
    try:
        return float(v) if v is not None else None
    except (ValueError, TypeError):
        return None


# ── Tier 1: Yahoo /v7/quote (crumb-authed) ──────────────────────────────────
def fetch_v7(ticker):
    if _yahoo_authed_fetch is None:
        return None
    data = _yahoo_authed_fetch(
        "https://query1.finance.yahoo.com/v7/finance/quote",
        params={"symbols": ticker},
    )
    if not data:
        return None
    arr = (data.get("quoteResponse") or {}).get("result") or []
    if not arr:
        return None
    q = arr[0]
    return {
        "name": q.get("longName") or q.get("shortName"),
        "exchange": q.get("fullExchangeName") or q.get("exchange"),
        "sector": q.get("sector"),
        "industry": q.get("industry"),
        "market_cap": q.get("marketCap"),
        "pe_ratio": q.get("trailingPE"),
        "forward_pe": q.get("forwardPE"),
        "pb_ratio": q.get("priceToBook"),
        "beta": q.get("beta"),
        "dividend_yield": q.get("trailingAnnualDividendYield") or q.get("dividendYield"),
        # Absolute INR-per-share annual dividend. Used by _normalize_dividend_yield
        # below as the source of truth — yield = rate/price is unambiguous.
        "dividend_rate": q.get("trailingAnnualDividendRate") or q.get("dividendRate"),
        "eps": q.get("epsTrailingTwelveMonths"),
        "fifty_two_week_high": q.get("fiftyTwoWeekHigh"),
        "fifty_two_week_low": q.get("fiftyTwoWeekLow"),
        "fifty_day_average": q.get("fiftyDayAverage"),
        "two_hundred_day_average": q.get("twoHundredDayAverage"),
        "shares_outstanding": q.get("sharesOutstanding"),
        "average_daily_volume": q.get("averageDailyVolume10Day"),
        "currency": q.get("currency") or "INR",
        "price": q.get("regularMarketPrice"),
        "prev_close": q.get("regularMarketPreviousClose"),
        "day_high": q.get("regularMarketDayHigh"),
        "day_low": q.get("regularMarketDayLow"),
        "volume": q.get("regularMarketVolume"),
        "change_pct": q.get("regularMarketChangePercent"),
        "source_tiers": ["yahoo_v7"],
    }


# ── Tier 2: Yahoo /v10/quoteSummary (crumb-authed) ──────────────────────────
def _raw(obj, *path):
    cur = obj
    for k in path:
        if cur is None:
            return None
        cur = cur.get(k) if isinstance(cur, dict) else None
    if isinstance(cur, dict):
        # Yahoo v10 wraps numbers in {raw, fmt, longFmt}. Pull the raw
        # number when present.
        if "raw" in cur:
            return cur.get("raw")
        # Empty dict {} or unrecognised shape — return None so downstream
        # JSON serialisation doesn't ship `{}` as the field value. Front-end
        # checks like `dividend_yield != null` treat `{}` as a valid value
        # and then `{}.toFixed(2)` blows up to "NaN%". Returning None here
        # makes the front-end's `_num()` guard work correctly.
        return None
    return cur


def fetch_v10(ticker):
    if _yahoo_authed_fetch is None:
        return None
    data = _yahoo_authed_fetch(
        f"https://query1.finance.yahoo.com/v10/finance/quoteSummary/{url_quote(ticker, safe='.')}",
        params={"modules": "summaryDetail,defaultKeyStatistics,financialData,price,summaryProfile,assetProfile"},
    )
    if not data:
        return None
    result = ((data.get("quoteSummary") or {}).get("result") or [None])[0]
    if not result:
        return None
    sd = result.get("summaryDetail") or {}
    ks = result.get("defaultKeyStatistics") or {}
    fd = result.get("financialData") or {}
    pr = result.get("price") or {}
    sp = result.get("summaryProfile") or {}
    ap = result.get("assetProfile") or {}
    price_val = _raw(pr, "regularMarketPrice") or _raw(sd, "regularMarketPreviousClose")
    shares = _raw(ks, "sharesOutstanding")
    mcap = _raw(pr, "marketCap") or (price_val * shares if (price_val and shares) else None)
    return {
        "name": _raw(pr, "longName") or _raw(pr, "shortName"),
        "exchange": _raw(pr, "exchangeName"),
        "sector": ap.get("sector") or sp.get("sector"),
        "industry": ap.get("industry") or sp.get("industry"),
        "market_cap": mcap,
        "pe_ratio": _raw(sd, "trailingPE"),
        "forward_pe": _raw(sd, "forwardPE"),
        "pb_ratio": _raw(ks, "priceToBook"),
        "beta": _raw(sd, "beta") or _raw(ks, "beta"),
        "dividend_yield": _raw(sd, "trailingAnnualDividendYield") or _raw(sd, "dividendYield"),
        # Absolute INR-per-share annual dividend (cross-checked in
        # _normalize_dividend_yield to reconcile fraction vs percent).
        "dividend_rate": _raw(sd, "trailingAnnualDividendRate") or _raw(sd, "dividendRate"),
        "eps": _raw(ks, "trailingEps") or _raw(fd, "currentPrice"),
        # ROE comes from financialData on Yahoo v10 (NOT defaultKeyStatistics
        # which has it under returnOnEquity but often null for non-US tickers).
        "roe": _raw(fd, "returnOnEquity"),
        # Debt-to-equity ratio. Yahoo's v10 financialData ships this for
        # most NSE-listed companies. Used by /api/screener to answer
        # "highest debt" / "lowest debt" / "leverage" queries.
        "debt_to_equity": _raw(fd, "debtToEquity"),
        "fifty_two_week_high": _raw(sd, "fiftyTwoWeekHigh"),
        "fifty_two_week_low": _raw(sd, "fiftyTwoWeekLow"),
        "fifty_day_average": _raw(sd, "fiftyDayAverage"),
        "two_hundred_day_average": _raw(sd, "twoHundredDayAverage"),
        "shares_outstanding": shares,
        "average_daily_volume": _raw(sd, "averageDailyVolume10Day"),
        "currency": _raw(pr, "currency") or "INR",
        "price": price_val,
        "prev_close": _raw(sd, "regularMarketPreviousClose"),
        "day_high": _raw(sd, "dayHigh"),
        "day_low": _raw(sd, "dayLow"),
        "volume": _raw(sd, "regularMarketVolume") or _raw(sd, "volume"),
        "change_pct": None,
        "source_tiers": ["yahoo_v10"],
    }


# ── Tier 3: Tickertape ──────────────────────────────────────────────────────
def fetch_tickertape(symbol):
    if _tickertape_fetch is None:
        return None
    r = _tickertape_fetch(symbol)
    if not r:
        return None
    # Tickertape ships TWO PE numbers: `pe` (annual fiscal-year ratio) and
    # `ttmPe` (trailing-12-months — matches Yahoo's `trailingPE`). For the
    # `pe_ratio` field exposed to the front-end we prefer ttmPe so all
    # tiers report on the same time window. Falls back to annual pe when
    # ttmPe is missing (rare — usually for newly-listed companies).
    pe_for_ui = r.get("pe_ttm") if r.get("pe_ttm") is not None else r.get("pe_ratio")
    return {
        "name": r.get("name"),
        # Tickertape's `info.sector` is a sub-industry (e.g. "Packaged Foods &
        # Meats"); `gic.sector` is the broad GIC sector ("Consumer Staples").
        # We pass both up so callers can pick whichever fits the UI taxonomy.
        "sector": r.get("sector_gic"),
        "industry": r.get("sector_tickertape"),
        "market_cap": r.get("market_cap"),
        "pe_ratio": pe_for_ui,
        "pe_ttm": r.get("pe_ttm"),
        "pe_annual": r.get("pe_ratio"),     # surfaced for power users
        "pb_ratio": r.get("pb_ratio"),
        "beta": r.get("beta"),
        "dividend_yield": r.get("dividend_yield"),
        "eps": r.get("eps"),
        "roe": r.get("roe"),
        "industry_pe": r.get("industry_pe"),
        "industry_pb": r.get("industry_pb"),
        "industry_dy": r.get("industry_dy"),
        "fifty_two_week_high": r.get("fifty_two_week_high"),
        "fifty_two_week_low": r.get("fifty_two_week_low"),
        "price": r.get("last_price"),
        "currency": "INR",
        "tickertape_sid": r.get("sid"),
        "market_cap_label": r.get("market_cap_label"),
        "source_tiers": ["tickertape"],
    }


# ── Tier 4: Yahoo /v8/chart (anonymous, last-resort) ────────────────────────
def fetch_v8_chart(ticker):
    for base in V8_HOSTS:
        data = _yahoo_anon_fetch(f"{base}/{url_quote(ticker, safe='.')}?interval=1d&range=1y")
        if not data:
            continue
        res = ((data.get("chart") or {}).get("result") or [None])[0]
        if not res:
            continue
        meta = res.get("meta") or {}
        hi = meta.get("fiftyTwoWeekHigh")
        lo = meta.get("fiftyTwoWeekLow")
        closes = ((res.get("indicators", {}).get("quote") or [{}])[0].get("close") or [])
        if hi is None or lo is None:
            non_null = [c for c in closes if c is not None]
            if non_null:
                hi = hi if hi is not None else max(non_null)
                lo = lo if lo is not None else min(non_null)
        prev = meta.get("regularMarketPreviousClose") or meta.get("previousClose")
        if prev is None:
            for i in range(len(closes) - 2, -1, -1):
                if closes[i] is not None:
                    prev = closes[i]
                    break
        price = meta.get("regularMarketPrice")
        return {
            "exchange": meta.get("exchangeName"),
            "fifty_two_week_high": hi,
            "fifty_two_week_low": lo,
            "currency": meta.get("currency") or "INR",
            "price": price,
            "prev_close": prev,
            "day_high": meta.get("regularMarketDayHigh"),
            "day_low": meta.get("regularMarketDayLow"),
            "volume": meta.get("regularMarketVolume"),
            "source_tiers": ["yahoo_v8_chart"],
        }
    return None


# ── Merge ───────────────────────────────────────────────────────────────────
def _merge(base, extra):
    """Non-destructive merge: extra fills in fields base has as None."""
    if not extra:
        return base
    if not base:
        return extra
    merged = dict(extra)
    merged.update({k: v for k, v in base.items() if v is not None})
    if "source_tiers" in extra:
        merged["source_tiers"] = list(dict.fromkeys((base.get("source_tiers") or []) + extra.get("source_tiers", [])))
    return merged


def _normalize_dividend_yield(r):
    """Reconcile dividend_yield units across tiers.

    Yahoo and Tickertape disagree on whether dividend_yield is a fraction
    (0.0041 = 0.41%) or a percent value (0.41 = 0.41%). Worse, Yahoo flips
    between the two depending on the symbol — observed live 2026-04-25:
      RELIANCE: 0.41 (percent-style — front-end ×100 renders "41.00%")
      ADFFOODS: 0.0048 (fraction-style — renders "0.48%", correct)
    Tickertape's _pct_to_frac already divides by 100, so its output is
    fraction. The mismatch lives entirely in Yahoo v7/v10's `dividendYield`
    field, which encodes the same number two different ways.

    Strategy:
      1. Source of truth: if `dividend_rate` (absolute INR/share) and
         `price` are both available, compute yield = rate / price. This
         is unambiguous and matches the way the NSE itself reports yield.
      2. Fallback heuristic: any dividend_yield > 0.3 is impossibly high
         as a fraction (>30% yield doesn't exist for any sane stock), so
         treat it as percent and divide by 100. The 0.3 threshold has a
         small ambiguity zone for ultra-low-yield growth stocks (0.2-0.3%
         as percent slips through), but rate/price covers those when the
         data is available, and the fallback is "show 20-30% yield" vs
         "show 0.20-0.30%" — both look obviously wrong, so users notice.
    """
    if not r:
        return r
    dy = r.get("dividend_yield")
    rate = r.get("dividend_rate")
    price = r.get("price") or r.get("prev_close")
    # Path A: divYield missing entirely → derive from rate/price if possible.
    if dy is None:
        try:
            if rate is not None and price is not None and float(price) > 0 and float(rate) > 0:
                r["dividend_yield"] = float(rate) / float(price)
        except (TypeError, ValueError):
            pass
        return r
    # Path B: divYield present and looks like a fraction (Tickertape after
    # _pct_to_frac, or Yahoo's `summaryDetail.dividendYield` raw → already
    # 0.0041 etc.). Trust it. Do NOT clobber with Yahoo's stale
    # `trailingAnnualDividendRate / price` — that field is a 12-month rolling
    # sum that lags actual recent dividend hikes, while Tickertape's value
    # is a fresh per-fiscal-quarter recomputation. Pre-Hotfix2 this was the
    # exact bug ADFFOODS hit: Tickertape said 0.48%, Yahoo's stale rate/
    # price said 0.46%, and the normalizer overwrote 0.48% with 0.46%.
    try:
        dy_f = float(dy)
        if dy_f > 0.3:
            # Path C: divYield arrived as percent (some Yahoo paths return
            # 0.41 meaning 0.41%). 0.3 threshold — no real-world stock
            # yields >30% as fraction.
            r["dividend_yield"] = dy_f / 100.0
        # else: 0 < dy ≤ 0.3 → already fraction-shaped, leave as-is.
    except (TypeError, ValueError):
        pass
    return r


def fetch_fundamentals(symbol, *, allow_cache=True, write_back=True):
    """Returns a merged fundamentals dict for an NSE symbol.

    Order: cache → Yahoo v7 (crumb) → Yahoo v10 (crumb) → Tickertape →
           Yahoo v8/chart anonymous.
    Each tier's non-null fields fill in gaps from earlier tiers.

    `allow_cache=False` skips the cache read (used by the daily refresh cron
    so it always pulls fresh upstream data).
    `write_back=False` skips the cache write (used when we got data from the
    cache itself — no point rewriting).
    """
    ticker = symbol if "." in symbol else f"{symbol}.NS"

    # Tier 0 — cache. Returns a complete row if fresh.
    # Cache may contain pre-normalization rows from earlier deploys (where
    # divYield=0.41 for RELIANCE got persisted in percent-style). Run
    # _normalize_dividend_yield on the way out so the front-end always
    # receives a fraction. Cache rows get rewritten by the daily cron in
    # the new shape; this read-side normalization closes the gap until
    # then without requiring a manual cache purge.
    if allow_cache:
        cached = read_cache(symbol)
        if cached and cached.get("market_cap") is not None and cached.get("pe_ratio") is not None:
            cached["symbol"] = symbol
            cached["ticker"] = ticker
            cached["source"] = "cache"
            _normalize_dividend_yield(cached)
            return cached

    # Tier 1+2+3+4 — fan-out merge. Tickertape ships first because it's a
    # dedicated finance API with self-consistent ratios — its dividend_yield,
    # PE (TTM), PB, beta, market_cap are typically fresher than Yahoo's
    # consumer-page-derived numbers (which lag because their
    # `trailingAnnualDividendRate` is a 12-month rolling sum that misses
    # recent dividend hikes). Yahoo v10 / v7 / v8 fill the gaps Tickertape
    # doesn't have (50-day-avg, 200-day-avg, exchange info, currency, OHLC).
    # _merge keeps the base value when present, so this priority is correct
    # for *every* field Tickertape ships.
    r = fetch_tickertape(symbol)
    r = _merge(r, fetch_v10(ticker))
    r = _merge(r, fetch_v7(ticker))
    r = _merge(r, fetch_v8_chart(ticker))

    if not r:
        return {"error": "all_sources_failed"}

    # Apply unit normalization BEFORE writing back to cache so the next read
    # already has the corrected fraction. Otherwise the cache poisons every
    # subsequent fetch for 24 h.
    _normalize_dividend_yield(r)

    r["symbol"] = symbol
    r["ticker"] = ticker
    r["source"] = "+".join(r.get("source_tiers") or ["unknown"])

    # Best-effort cache write — service-role-keyed; silent on failure.
    if write_back:
        write_cache(symbol, r)

    return r


# ── HTTP handler ────────────────────────────────────────────────────────────
class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        symbol = (q.get("symbol") or [""])[0].strip().upper()
        nocache = (q.get("nocache") or ["0"])[0] == "1"
        if not symbol or not _SYMBOL_RE.match(symbol):
            self._json(400, {"ok": False, "error": "bad_symbol"})
            return
        data = fetch_fundamentals(symbol, allow_cache=not nocache)
        if data.get("error"):
            self._json(502, {"ok": False, **data})
            return
        self._json(200, {"ok": True, **data})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # Cache fundamentals at the edge for 5 min (the upstream values change
        # at most a few times per trading day — the Supabase cache + edge
        # cache together absorb 99% of repeat hits).
        self.send_header("Cache-Control", "public, max-age=300, stale-while-revalidate=3600")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
