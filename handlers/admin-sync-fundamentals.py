"""GET/POST /api/admin-sync-fundamentals — daily fundamentals refresh.

For each active symbol in `dhan_instruments`, fetch fundamentals via the
4-tier chain (Yahoo crumb v7+v10, Tickertape, v8/chart) and upsert to
`fundamentals_cache`. Soft-throttled with a small inter-request delay so we
don't hammer Yahoo or Tickertape.

Auth: Authorization: Bearer <ADMIN_TOKEN>  (manual trigger via /api/ai)
   OR Authorization: Bearer <CRON_SECRET>  (Vercel cron auto-injects)

Vercel maxDuration is 60s; at ~2300 stocks × 80ms ≈ 3 min total, we have
to chunk. Strategy: accept `?offset=0&limit=400` query params; the cron
fires multiple times per day (e.g. 13:15 / 13:20 / 13:25 / 13:30 / 13:35
/ 13:40 UTC) with different offsets so each invocation finishes in well
under 60s. Idempotent — re-running with the same offset is harmless.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote as url_quote

# Same path-injection as fundamentals.py — Vercel doesn't auto-add api/ to
# sys.path so sibling imports fail silently without this.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Sibling helpers (api/_yahoo_session.py + api/_tickertape.py + api/fundamentals.py)
try:
    from fundamentals import fetch_fundamentals, write_cache
    from _tickertape import lookup_sid, get_sid_cache, warm_sid_cache
except Exception as _import_err:
    fetch_fundamentals = None
    write_cache = None
    lookup_sid = None
    get_sid_cache = None
    warm_sid_cache = None

SUPA_URL    = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_SRV    = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()
CRON_SECRET = os.environ.get("CRON_SECRET", "").strip()

DEFAULT_LIMIT = int(os.environ.get("FUND_SYNC_BATCH", "400"))
INTER_REQUEST_DELAY_MS = int(os.environ.get("FUND_SYNC_DELAY_MS", "80"))


def _supa_headers(extra=None):
    h = {
        "apikey": SUPA_SRV,
        "Authorization": f"Bearer {SUPA_SRV}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def fetch_active_symbols(offset=0, limit=400):
    """Pull a slice of active symbols (kind=EQUITY only — ETFs use a separate
    cron, MFs come from AMFI). Ordered by `idx_tags desc, symbol asc` so
    Nifty 50/100 names get refreshed first when the cron runs."""
    url = (f"{SUPA_URL}/rest/v1/dhan_instruments"
           f"?select=symbol,idx_tags&is_active=eq.true&kind=eq.EQUITY"
           f"&order=idx_tags.desc,symbol.asc"
           f"&offset={offset}&limit={limit}")
    req = urllib.request.Request(url, headers=_supa_headers({"Accept": "application/json"}))
    with urllib.request.urlopen(req, timeout=10) as r:
        return [row["symbol"] for row in json.loads(r.read())]


def fetch_known_sids():
    """Read tickertape_sids table to warm the in-process cache and skip
    redundant search round-trips."""
    if not (SUPA_URL and SUPA_SRV):
        return []
    url = f"{SUPA_URL}/rest/v1/tickertape_sids?select=symbol,sid&limit=20000"
    try:
        req = urllib.request.Request(url, headers=_supa_headers({"Accept": "application/json"}))
        with urllib.request.urlopen(req, timeout=10) as r:
            rows = json.loads(r.read())
        return [(row["symbol"], row["sid"]) for row in rows]
    except Exception:
        return []


def persist_sid_cache(sid_map):
    """Bulk-upsert any new (symbol, sid) pairs picked up during this run."""
    if not (SUPA_URL and SUPA_SRV) or not sid_map:
        return 0
    rows = [{"symbol": s, "sid": sid, "resolved_at": "now()"} for s, sid in sid_map.items()]
    body = json.dumps([{"symbol": s, "sid": sid} for s, sid in sid_map.items()]).encode("utf-8")
    url = f"{SUPA_URL}/rest/v1/tickertape_sids"
    headers = _supa_headers({"Prefer": "resolution=merge-duplicates,return=minimal"})
    try:
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()
        return len(sid_map)
    except Exception:
        return 0


def _auth_ok(authz_header):
    if not authz_header:
        return False
    raw = authz_header
    if raw.lower().startswith("bearer "):
        raw = raw[7:]
    raw = raw.strip()
    if not raw:
        return False
    for expected in (ADMIN_TOKEN, CRON_SECRET):
        if not expected:
            continue
        if len(raw) != len(expected):
            continue
        diff = 0
        for a, b in zip(raw, expected):
            diff |= ord(a) ^ ord(b)
        if diff == 0:
            return True
    return False


def _run_sync(offset, limit):
    if not (SUPA_URL and SUPA_SRV):
        return {"ok": False, "error": "supabase_not_configured"}
    if fetch_fundamentals is None:
        return {"ok": False, "error": "imports_failed"}

    t0 = time.time()
    # 1) Warm sid cache from DB so we skip search round-trips for known stocks.
    if warm_sid_cache:
        warm_sid_cache(fetch_known_sids())

    # 2) Pull the symbol slice.
    symbols = fetch_active_symbols(offset=offset, limit=limit)
    if not symbols:
        return {"ok": True, "processed": 0, "offset": offset, "limit": limit, "next_offset": None}

    # 3) Refresh each. fetch_fundamentals(allow_cache=False) skips the DB
    #    read but write_back=True still upserts the new row. This always
    #    pulls fresh upstream data.
    success = 0
    failed = 0
    for sym in symbols:
        try:
            r = fetch_fundamentals(sym, allow_cache=False, write_back=True)
            if r and not r.get("error") and (r.get("market_cap") is not None or r.get("pe_ratio") is not None):
                success += 1
            else:
                failed += 1
        except Exception:
            failed += 1
        # Soft throttle.
        time.sleep(INTER_REQUEST_DELAY_MS / 1000.0)
        # Bail out if we're close to Vercel's 60s timeout — return what we have.
        if (time.time() - t0) > 50:
            break

    # 4) Persist any new sid mappings the Tickertape calls picked up.
    new_sids = 0
    if get_sid_cache:
        new_sids = persist_sid_cache(get_sid_cache())

    next_offset = offset + len(symbols) if len(symbols) >= limit else None

    return {
        "ok": True,
        "offset": offset,
        "limit": limit,
        "processed": success + failed,
        "success": success,
        "failed": failed,
        "new_sids": new_sids,
        "duration_ms": int((time.time() - t0) * 1000),
        "next_offset": next_offset,
    }


class handler(BaseHTTPRequestHandler):
    def _reply(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _run(self):
        if not _auth_ok(self.headers.get("Authorization")):
            return self._reply(401, {"ok": False, "error": "unauthorized"})
        q = parse_qs(urlparse(self.path).query)
        try:
            offset = max(0, int((q.get("offset") or ["0"])[0]))
            limit  = max(1, min(int((q.get("limit") or [str(DEFAULT_LIMIT)])[0]), 800))
        except (ValueError, TypeError):
            offset, limit = 0, DEFAULT_LIMIT
        try:
            return self._reply(200, _run_sync(offset, limit))
        except Exception as e:
            return self._reply(500, {"ok": False, "error": "sync_failed", "detail": str(e)[:400]})

    def do_GET(self):  self._run()
    def do_POST(self): self._run()
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.end_headers()
