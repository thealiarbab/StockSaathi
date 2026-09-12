"""GET /api/live-quote?symbols=A,B,C — cache-first live quote aggregator.

Architecture:
  1. Check Supabase `quote_cache` table for each symbol.
     Rows newer than CACHE_TTL_MS are served straight back.
  2. For cache misses, fall through a source chain:
        Dhan REST  →  Yahoo v8/chart  →  existing /api/quotes fallback
     First source that returns data wins. Subsequent sources are not called.
  3. Upsert fresh data into `quote_cache` so other users / tabs benefit.

Designed so hundreds of concurrent users polling the same symbols hit the
external APIs only ~6 times per minute total (cache-TTL-bound), instead of
once per user per poll. Matches the Groww/Zerodha "single upstream feed +
fanout to clients" pattern, but runs entirely on Vercel + Supabase.

Required env vars on Vercel:
  SUPABASE_URL                    (already set for /api/config)
  SUPABASE_SERVICE_ROLE_KEY       (NEW — add this; never exposed to client)

Optional (enables Dhan real-time, replaces Yahoo once configured):
  DHAN_ACCESS_TOKEN               long-lived API token from dhan.co
  DHAN_CLIENT_ID                  your Dhan user ID

Without Dhan env vars → falls through to Yahoo. Same data you have today,
but cached 10s across all users, dramatically reducing Yahoo rate-limit
hits and fixing the 2-hour-stale problem.
"""

import os
import re
import json
import time
import urllib.request
import urllib.error
import concurrent.futures
from datetime import datetime
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote as url_quote

try:
    from zoneinfo import ZoneInfo  # py3.9+
    _IST = ZoneInfo("Asia/Kolkata")
except Exception:   # pragma: no cover — older Pythons fall back to UTC offset
    _IST = None

SUPA_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_SRV = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
DHAN_TOKEN = os.environ.get("DHAN_ACCESS_TOKEN", "").strip()
DHAN_CLIENT = os.environ.get("DHAN_CLIENT_ID", "").strip()

# Cache TTL — tuned per market state instead of a single constant.
# Reasoning:
#   * Market OPEN (Mon-Fri 09:15-15:30 IST): prices tick every second, so we
#     want a short cache so the displayed number never lags more than a few
#     seconds. 5s is short enough that humans can't tell it's cached but long
#     enough that a burst of clients all polling the same symbol only hits
#     Yahoo/Dhan once per 5-second window.
#   * Market CLOSED: the official closing tick is frozen until next session,
#     so there is nothing to refresh for. 5 minutes keeps the number in memory
#     between pageloads while virtually eliminating upstream traffic.
# The env var QUOTE_CACHE_TTL_MS still wins if explicitly set — infra people
# can override without touching the code path.
CACHE_TTL_OPEN_MS = int(os.environ.get("QUOTE_CACHE_TTL_OPEN_MS", "5000"))
CACHE_TTL_CLOSED_MS = int(os.environ.get("QUOTE_CACHE_TTL_CLOSED_MS", "300000"))
CACHE_TTL_MS_DEFAULT = int(os.environ.get("QUOTE_CACHE_TTL_MS", "0"))   # 0 → use open/closed split


def is_market_open_ist(now_ms=None):
    """True during IST market hours (Mon-Fri 09:15-15:30). Holidays ignored
    (they are rare and the cost of treating them as 'open' is one upstream
    hit per 5s that returns yesterday's close)."""
    if _IST is None:
        # Pre-3.9 runtime with no zoneinfo — be conservative and behave as
        # "closed" so we don't accidentally spam upstream with a 5s TTL over
        # a wrong timezone guess. Vercel Python runtime is 3.9+ so this
        # branch is dead code in practice; kept for local-dev safety.
        return False
    try:
        ms = now_ms if now_ms is not None else int(time.time() * 1000)
        t = datetime.fromtimestamp(ms / 1000, tz=_IST)
        if t.weekday() >= 5:   # 5 = Sat, 6 = Sun
            return False
        mins = t.hour * 60 + t.minute
        return (9 * 60 + 15) <= mins < (15 * 60 + 30)
    except Exception:
        return False


def current_ttl_ms():
    """Active TTL for this moment. Honours QUOTE_CACHE_TTL_MS override."""
    if CACHE_TTL_MS_DEFAULT:
        return CACHE_TTL_MS_DEFAULT
    return CACHE_TTL_OPEN_MS if is_market_open_ist() else CACHE_TTL_CLOSED_MS


# Back-compat: module-level constant still exported (used by other parts of
# the codebase that introspect it for `cache_ttl_ms` in the JSON response).
CACHE_TTL_MS = CACHE_TTL_OPEN_MS   # "worst case" default for static refs

_SYMBOL_RE = re.compile(r"^[A-Z0-9.\-\^=_&]{1,24}$")
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
       "AppleWebKit/537.36 (KHTML, like Gecko) "
       "Chrome/125.0.0.0 Safari/537.36")

YAHOO_HOSTS = [
    "https://query1.finance.yahoo.com/v8/finance/chart",
    "https://query2.finance.yahoo.com/v8/finance/chart",
]
MAX_SYMBOLS = 80


# --------------------------------------------------------------------------
# Supabase cache (uses PostgREST with service_role auth)
# --------------------------------------------------------------------------

def _supa_headers():
    return {
        "apikey": SUPA_SRV,
        "Authorization": f"Bearer {SUPA_SRV}",
        "Content-Type": "application/json",
    }


def read_cache(symbols, ttl_ms=None):
    """Returns {symbol: row_dict} for rows WRITTEN to cache within ttl_ms.
    Filters on cached_at_ms (when our server wrote), NOT ts_ms (Yahoo market
    time, which can be hours stale during Yahoo lag)."""
    if not (SUPA_URL and SUPA_SRV) or not symbols:
        return {}
    effective_ttl = ttl_ms if ttl_ms is not None else current_ttl_ms()
    cutoff = int(time.time() * 1000) - effective_ttl
    sym_list = ",".join(f'"{s}"' for s in symbols)
    url = (f"{SUPA_URL}/rest/v1/quote_cache"
           f"?symbol=in.({sym_list})"
           f"&cached_at_ms=gte.{cutoff}"
           f"&select=*")
    req = urllib.request.Request(url, headers=_supa_headers())
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            rows = json.loads(r.read().decode("utf-8"))
        return {row["symbol"]: row for row in rows}
    except Exception:
        return {}


_last_write_error = {"status": None, "body": None, "key_prefix": None}

def write_cache(rows):
    """Upsert rows into quote_cache. Stores last failure for diagnostics."""
    global _last_write_error
    if not (SUPA_URL and SUPA_SRV) or not rows:
        _last_write_error = {"status": "skipped", "body": "SUPA_URL or SUPA_SRV empty", "key_prefix": None}
        return
    url = f"{SUPA_URL}/rest/v1/quote_cache"
    headers = _supa_headers()
    headers["Prefer"] = "resolution=merge-duplicates,return=minimal"
    body = json.dumps(rows).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        r = urllib.request.urlopen(req, timeout=3)
        _last_write_error = {"status": r.status, "body": None, "key_prefix": SUPA_SRV[:12] + "..."}
    except urllib.error.HTTPError as e:
        try: err_body = e.read().decode("utf-8")[:300]
        except Exception: err_body = str(e)
        _last_write_error = {"status": e.code, "body": err_body, "key_prefix": SUPA_SRV[:12] + "..."}
    except Exception as e:
        _last_write_error = {"status": "exception", "body": str(e)[:200], "key_prefix": SUPA_SRV[:12] + "..."}


# --------------------------------------------------------------------------
# Dhan REST — LTP batch endpoint (free with Dhan account)
# Returns {symbol: quote-dict} or {} if unconfigured/failed.
# Symbols that aren't in dhan_instruments are silently skipped so Yahoo
# can pick them up.
# --------------------------------------------------------------------------

def fetch_dhan_ltp(symbols):
    if not (DHAN_TOKEN and DHAN_CLIENT and SUPA_URL and SUPA_SRV):
        return {}
    # Resolve symbols → Dhan security_ids via the mapping table.
    sym_list = ",".join(f'"{s}"' for s in symbols)
    mapping_url = (f"{SUPA_URL}/rest/v1/dhan_instruments"
                   f"?symbol=in.({sym_list})&select=symbol,security_id,exchange_segment")
    try:
        req = urllib.request.Request(mapping_url, headers=_supa_headers())
        with urllib.request.urlopen(req, timeout=3) as r:
            mapping_rows = json.loads(r.read().decode("utf-8"))
    except Exception:
        return {}
    if not mapping_rows:
        return {}
    # Group by exchange segment → list of security_ids (Dhan's LTP endpoint format).
    by_segment = {}
    id_to_sym = {}
    for row in mapping_rows:
        seg = row.get("exchange_segment") or "NSE_EQ"
        sid = row["security_id"]
        by_segment.setdefault(seg, []).append(sid)
        id_to_sym[(seg, sid)] = row["symbol"]
    payload = {seg: ids for seg, ids in by_segment.items()}
    req = urllib.request.Request(
        "https://api.dhan.co/v2/marketfeed/ltp",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "access-token": DHAN_TOKEN,
            "client-id": DHAN_CLIENT,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=4) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception:
        return {}
    # Dhan response: {"data": {"NSE_EQ": {"11536": {"last_price": 1360.8, ...}}}}
    out = {}
    for seg, per_seg in (data.get("data") or {}).items():
        for sid_str, info in per_seg.items():
            try:
                sid = int(sid_str)
            except (TypeError, ValueError):
                continue
            sym = id_to_sym.get((seg, sid))
            if not sym:
                continue
            price = info.get("last_price") or info.get("ltp")
            if price is None:
                continue
            prev = info.get("previous_close") or info.get("close") or price
            out[sym] = {
                "symbol": sym,
                "price": float(price),
                "prev_close": float(prev),
                "change_pct": ((float(price) - float(prev)) / float(prev)) if prev else 0.0,
                "day_high": float(info.get("high") or price),
                "day_low": float(info.get("low") or price),
                "volume": int(info.get("volume") or 0),
                "ts_ms": int(time.time() * 1000),
                "source": "dhan",
                "currency": "INR",
            }
    return out


# --------------------------------------------------------------------------
# Yahoo fallback (mirrors api/quotes.py fetch_one but inlined + concurrent)
# --------------------------------------------------------------------------

def fetch_yahoo_one(symbol):
    # The universe ships 1,145 BSE rows and 542 NSE_SME rows alongside
    # 2,680 NSE ones, but this only ever asked Yahoo for ".NS", so every
    # BSE-only listing resolved to nothing. Try NSE first (unchanged for
    # the common case), then fall back to ".BO". Costs one extra request
    # only for symbols that were previously returning no price at all.
    tickers = [symbol] if "." in symbol else [f"{symbol}.NS", f"{symbol}.BO"]
    for ticker, base in ((t, b) for t in tickers for b in YAHOO_HOSTS):
        try:
            url = f"{base}/{url_quote(ticker, safe='.')}?interval=1d&range=5d"
            req = urllib.request.Request(url, headers={
                "User-Agent": _UA,
                "Accept": "application/json,text/plain,*/*",
                "Accept-Language": "en-US,en;q=0.9",
            })
            with urllib.request.urlopen(req, timeout=3.5) as r:
                data = json.loads(r.read())
            result = (data.get("chart") or {}).get("result") or [{}]
            if not result:
                continue
            meta = result[0].get("meta") or {}
            price = meta.get("regularMarketPrice")
            if price is None:
                continue
            # Yahoo strips regularMarketPreviousClose + previousClose when
            # rate-limiting Vercel's IP pool. Fall back to the chart closes[]
            # array — second-to-last non-null value is yesterday's close
            # (last entry is today's in-progress bar).
            closes_arr = ((result[0].get("indicators", {}).get("quote") or [{}])[0]
                          .get("close") or [])
            prev_from_chart = None
            for i in range(len(closes_arr) - 2, -1, -1):
                if closes_arr[i] is not None:
                    prev_from_chart = closes_arr[i]
                    break
            prev = (meta.get("regularMarketPreviousClose")
                    or meta.get("previousClose")
                    or prev_from_chart
                    or meta.get("chartPreviousClose")
                    or price)
            ts_ms = int((meta.get("regularMarketTime") or 0)) * 1000 or int(time.time() * 1000)
            return {
                "symbol": symbol,
                "price": float(price),
                "prev_close": float(prev),
                "change_pct": ((float(price) - float(prev)) / float(prev)) if prev else 0.0,
                "day_high": float(meta.get("regularMarketDayHigh") or price),
                "day_low": float(meta.get("regularMarketDayLow") or price),
                "volume": int(meta.get("regularMarketVolume") or 0),
                "ts_ms": ts_ms,
                "source": "yahoo",
                "currency": meta.get("currency") or "INR",
            }
        except Exception:
            continue
    return None


def fetch_yahoo_batch(symbols):
    out = {}
    if not symbols:
        return out
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(40, len(symbols))) as ex:
        futures = {ex.submit(fetch_yahoo_one, s): s for s in symbols}
        for f in concurrent.futures.as_completed(futures, timeout=8):
            s = futures[f]
            try:
                r = f.result()
                if r:
                    out[s] = r
            except Exception:
                pass
    return out


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------

def _to_cache_row(q):
    """Convert a fetched quote dict to a quote_cache row.
    ts_ms  = upstream market time (Yahoo regularMarketTime / Dhan trade ts).
    cached_at_ms = when OUR server wrote this row. Used for TTL eviction.
    """
    return {
        "symbol": q["symbol"],
        "price_paise": int(round(q["price"] * 100)),
        "prev_close_paise": int(round(q["prev_close"] * 100)),
        "day_high_paise": int(round(q["day_high"] * 100)),
        "day_low_paise": int(round(q["day_low"] * 100)),
        "volume": q.get("volume", 0),
        "change_pct": q.get("change_pct", 0.0),
        "ts_ms": q["ts_ms"],
        "cached_at_ms": int(time.time() * 1000),
        "source": q.get("source", "yahoo"),
    }


def _quote_from_cache_row(row):
    """Convert a cache row back into the public API shape (rupees, not paise)."""
    return {
        "symbol": row["symbol"],
        "price": row["price_paise"] / 100.0,
        "prev_close": (row.get("prev_close_paise") or 0) / 100.0,
        "change_pct": row.get("change_pct") or 0.0,
        "day_high": (row.get("day_high_paise") or 0) / 100.0,
        "day_low": (row.get("day_low_paise") or 0) / 100.0,
        "volume": row.get("volume") or 0,
        "ts_ms": row["ts_ms"],
        "source": row.get("source") or "yahoo",
        "currency": "INR",
        "cached": True,
    }


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        # Accept either `symbols=A,B` (batch) or `symbol=X` (single, for the
        # refresh-button path which hits /api/quote but we support here too
        # for the StockDetail freshness refresh button).
        raw = (q.get("symbols") or [""])[0]
        if not raw:
            raw = (q.get("symbol") or [""])[0]
        raw_syms = [s.strip().upper() for s in raw.split(",") if s.strip()][:MAX_SYMBOLS]
        # Filter regex AND drop MF symbols — they have no Yahoo coverage.
        # Front-end's symbolsToPoll() in stocks.js already excludes kind="MF",
        # but defence-in-depth: if a stale cache or tab-switch race lands an
        # MF symbol here, drop it silently rather than burning a 5s Yahoo
        # round-trip per MF only to 404.
        syms = [s for s in raw_syms if _SYMBOL_RE.match(s) and not s.startswith("MF_")]
        # nocache=1 skips the Supabase cache read entirely and forces an
        # upstream fetch. Response gets a no-store Cache-Control so the
        # Vercel edge + browser can't serve their own cached copy.
        nocache = (q.get("nocache") or ["0"])[0] == "1"
        if not syms:
            self._json(400, {"ok": False, "error": "no_valid_symbols"}, nocache=nocache)
            return

        t0 = time.time()
        ttl_ms = current_ttl_ms()
        market_open = is_market_open_ist()

        # 1. Cache sweep (skipped when nocache=1)
        cached = {} if nocache else read_cache(syms, ttl_ms=ttl_ms)
        missing = [s for s in syms if s not in cached]

        # 2. Source chain for misses: Dhan → Yahoo
        fresh = {}
        if missing:
            if DHAN_TOKEN:
                fresh = fetch_dhan_ltp(missing)
            yahoo_targets = [s for s in missing if s not in fresh]
            if yahoo_targets:
                y = fetch_yahoo_batch(yahoo_targets)
                fresh.update(y)

        # 3. Write fresh rows back to cache (best-effort, no await)
        if fresh:
            write_cache([_to_cache_row(q) for q in fresh.values()])

        # 4. Build response
        quotes = {}
        for s in syms:
            if s in fresh:
                quotes[s] = fresh[s]
            elif s in cached:
                quotes[s] = _quote_from_cache_row(cached[s])
            else:
                quotes[s] = None

        hits = sum(1 for v in quotes.values() if v)
        latency_ms = int((time.time() - t0) * 1000)
        self._json(200, {
            "ok": True,
            "quotes": quotes,
            "hits": hits,
            "total": len(syms),
            "cached_count": len(cached),
            "fresh_count": len(fresh),
            "latency_ms": latency_ms,
            "cache_ttl_ms": ttl_ms,
            "market_open": market_open,
            "sources_enabled": {
                "dhan": bool(DHAN_TOKEN),
                "yahoo": True,
                "cache": bool(SUPA_URL and SUPA_SRV),
            },
        }, nocache=nocache, ttl_ms=ttl_ms)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def _json(self, code, obj, nocache=False, ttl_ms=None):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        if nocache:
            # Refresh-button path — propagate no-store all the way out.
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
        else:
            # Edge-cache in lockstep with our Supabase TTL (market-aware).
            # Open: 5s edge TTL. Closed: 300s edge TTL.
            edge_ttl = max(1, (ttl_ms if ttl_ms is not None else current_ttl_ms()) // 1000)
            self.send_header("Cache-Control", f"public, max-age={edge_ttl}")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
