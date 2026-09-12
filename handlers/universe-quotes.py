"""POST /api/universe-quotes — cache-only batch quote reader for the full universe.

Designed for the 2700-symbol screener / market-wide view. Unlike /api/live-quote
(cache-FIRST + Dhan/Yahoo fall-through), this endpoint is cache-ONLY: it queries
Supabase quote_cache and returns whatever it has, with null for misses. NEVER
triggers an upstream fetch — that's the warmer cron + per-symbol /api/live-quote.

Why a separate endpoint:
  * Up to 2500 symbols per request → POST is mandatory (URL length).
  * No upstream fan-out → cache-cold doesn't cascade into 2500 Yahoo hits.
  * Single PostgREST GET (chunked) covers the universe in one round trip; p50
    well under 200 ms even at 2200 symbols.
"""

import os
import re
import json
import time
import urllib.request
import urllib.error
from datetime import datetime
from http.server import BaseHTTPRequestHandler

try:
    from zoneinfo import ZoneInfo
    _IST = ZoneInfo("Asia/Kolkata")
except Exception:
    _IST = None

SUPA_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_ANON = os.environ.get("SUPABASE_ANON_KEY", "").strip()
SUPA_SRV = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
# Prefer anon for read-only path (lower blast radius); fall back to service role.
SUPA_KEY = SUPA_ANON or SUPA_SRV

MAX_SYMBOLS = 2500
# PostgREST `in.(...)` URL grows fast. 250 symbols/chunk keeps each GET ~6 KB,
# well under PostgREST and Vercel limits.
CHUNK_SIZE = 250

STALE_OPEN_MS = int(os.environ.get("UNIVERSE_STALE_OPEN_MS", str(5 * 60 * 1000)))
STALE_CLOSED_MS = int(os.environ.get("UNIVERSE_STALE_CLOSED_MS", str(24 * 60 * 60 * 1000)))

_SYMBOL_RE = re.compile(r"^[A-Z0-9.\-\^=_&]{1,24}$")
_ALLOW_ORIGIN = "*"


def is_market_open_ist(now_ms=None):
    if _IST is None:
        return False
    try:
        ms = now_ms if now_ms is not None else int(time.time() * 1000)
        t = datetime.fromtimestamp(ms / 1000, tz=_IST)
        if t.weekday() >= 5:
            return False
        mins = t.hour * 60 + t.minute
        return (9 * 60 + 15) <= mins < (15 * 60 + 30)
    except Exception:
        return False


def _stale_threshold_ms():
    return STALE_OPEN_MS if is_market_open_ist() else STALE_CLOSED_MS


def _supa_headers():
    return {
        "apikey": SUPA_KEY,
        "Authorization": f"Bearer {SUPA_KEY}",
        "Content-Type": "application/json",
    }


def _quote_from_cache_row(row, stale_cutoff_ms):
    cached_at = row.get("cached_at_ms") or 0
    return {
        "symbol": row["symbol"],
        "price": (row.get("price_paise") or 0) / 100.0,
        "prev_close": (row.get("prev_close_paise") or 0) / 100.0,
        "change_pct": row.get("change_pct") or 0.0,
        "day_high": (row.get("day_high_paise") or 0) / 100.0,
        "day_low": (row.get("day_low_paise") or 0) / 100.0,
        "volume": row.get("volume") or 0,
        "ts_ms": row.get("ts_ms") or cached_at,
        "cached_at_ms": cached_at,
        "source": row.get("source") or "yahoo",
        "currency": "INR",
        "cached": True,
        "stale": cached_at < stale_cutoff_ms,
    }


def read_cache_bulk(symbols):
    if not (SUPA_URL and SUPA_KEY) or not symbols:
        return {}
    out = {}
    for i in range(0, len(symbols), CHUNK_SIZE):
        chunk = symbols[i:i + CHUNK_SIZE]
        sym_list = ",".join(f'"{s}"' for s in chunk)
        url = (f"{SUPA_URL}/rest/v1/quote_cache"
               f"?symbol=in.({sym_list})&select=*")
        req = urllib.request.Request(url, headers=_supa_headers())
        try:
            with urllib.request.urlopen(req, timeout=4) as r:
                rows = json.loads(r.read().decode("utf-8"))
            for row in rows:
                out[row["symbol"]] = row
        except Exception:
            # One bad chunk shouldn't blank the whole response.
            continue
    return out


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0 or length > 256 * 1024:
            self._json(400, {"ok": False, "error": "missing_or_oversized_body"})
            return
        try:
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            self._json(400, {"ok": False, "error": "invalid_json"})
            return

        syms_in = payload.get("symbols")
        if not isinstance(syms_in, list):
            self._json(400, {"ok": False, "error": "symbols_must_be_array"})
            return
        if len(syms_in) > MAX_SYMBOLS:
            self._json(400, {"ok": False, "error": "too_many_symbols",
                             "max": MAX_SYMBOLS, "received": len(syms_in)})
            return

        seen = set()
        syms = []
        for s in syms_in:
            if not isinstance(s, str):
                continue
            u = s.strip().upper()
            if not u or u in seen or not _SYMBOL_RE.match(u):
                continue
            seen.add(u)
            syms.append(u)
        if not syms:
            self._json(400, {"ok": False, "error": "no_valid_symbols"})
            return

        t0 = time.time()
        rows = read_cache_bulk(syms)
        now_ms = int(time.time() * 1000)
        stale_cutoff = now_ms - _stale_threshold_ms()

        quotes = {}
        hits = 0
        stale_count = 0
        for s in syms:
            row = rows.get(s)
            if row is None:
                quotes[s] = None
                continue
            q = _quote_from_cache_row(row, stale_cutoff)
            quotes[s] = q
            hits += 1
            if q["stale"]:
                stale_count += 1

        latency_ms = int((time.time() - t0) * 1000)
        self._json(200, {
            "ok": True,
            "as_of": now_ms,
            "quotes": quotes,
            "hits": hits,
            "total": len(syms),
            "stale_count": stale_count,
            "market_open": is_market_open_ist(now_ms),
            "stale_threshold_ms": _stale_threshold_ms(),
            "latency_ms": latency_ms,
        })

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", _ALLOW_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        self._json(405, {"ok": False, "error": "method_not_allowed",
                         "hint": "POST {\"symbols\":[...]} to this endpoint"})

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", _ALLOW_ORIGIN)
        self.end_headers()
        self.wfile.write(body)
