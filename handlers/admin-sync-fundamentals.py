"""GET/POST /api/admin-sync-fundamentals — daily fundamentals refresh.

For each active symbol in `dhan_instruments`, fetch fundamentals via the
4-tier chain (Yahoo crumb v7+v10, Tickertape, v8/chart) and upsert to
`fundamentals_cache`. Soft-throttled with a small inter-request delay so we
don't hammer Yahoo or Tickertape.

Auth: Authorization: Bearer <ADMIN_TOKEN>  (manual trigger via /api/ai)
   OR Authorization: Bearer <CRON_SECRET>  (Vercel cron auto-injects)

Symbols come STALEST FIRST from the fundamentals_refresh_queue RPC, not from
an offset. Real throughput is ~1 symbol/s (each one walks up to four upstream
tiers), so a page covers a few dozen symbols before the time budget stops it.
The old caller stepped a fixed offset by +500 per page regardless, which
refreshed the same ~225 symbols every night and never reached the rest of the
4,457 -- including SBIN, SUNPHARMA, TITAN and WIPRO. A staleness queue cannot
skip: whatever this page doesn't reach is still stalest for the next one.

Every attempt, success or not, is written to fundamentals_sync_attempts so a
symbol with no upstream data can't sit at the head of the queue forever.

The caller pages until `processed` is 0 or its nightly cap is reached.
`offset` is only honoured by the committed-universe fallback.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs, quote as url_quote

# Same path-injection as fundamentals.py — Vercel doesn't auto-add api/ to
# sys.path so sibling imports fail silently without this.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _budget import Budget  # noqa: E402

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


_UNIVERSE_CACHE = None


def _symbols_from_committed_universe(offset, limit):
    """Fallback symbol source: the committed js/data/universeFull.json.

    dhan_instruments is populated by /api/admin-sync-instruments, which fetches
    EQUITY_L.csv from NSE -- and NSE blocks Vercel, so that sync fails its own
    sanity gate ("only 0 equities") every run and the table has stayed at 0
    rows. With no symbols to iterate, this cron answered
    {"ok": true, "processed": 0} for every page while doing nothing, so
    fundamentals_cache never filled and handlers/screener.py kept serving the
    committed js/data/fundamentals_full.json from April.

    universeFull.json is the same data, is rebuilt weekly by
    .github/workflows/universe-refresh.yml (GitHub runners CAN reach NSE), and
    ships in the bundle. handlers/screener.py already reads its own committed
    JSON from these same paths.

    Ordered so index constituents refresh first, which is what the
    dhan_instruments query intends. Note `idx` in universeFull.json is an
    index-tier CODE, not a rank -- 7 = Nifty 50 (RELIANCE/TCS/HDFCBANK/INFY
    all carry 7), 6 = the next 50, 12 = Midcap 150, 20 = Smallcap 250, 0 =
    unindexed. Sorting it descending would refresh smallcaps before Nifty 50,
    so map it to an explicit priority instead.
    """
    global _UNIVERSE_CACHE
    if _UNIVERSE_CACHE is None:
        rows = []
        for path in (
            os.path.join(os.path.dirname(__file__), "..", "js", "data", "universeFull.json"),
            os.path.join(os.getcwd(), "js", "data", "universeFull.json"),
            os.path.join("/var/task", "js", "data", "universeFull.json"),
        ):
            try:
                with open(path, encoding="utf-8") as fh:
                    rows = json.load(fh)
                break
            except Exception:
                continue
        eq = [r for r in rows if (r.get("kind") or "") == "EQUITY" and r.get("symbol")]
        # idx code -> refresh priority (lower sorts first).
        rank = {7: 0, 6: 1, 12: 2, 20: 3}
        eq.sort(key=lambda r: (rank.get(r.get("idx") or 0, 9), r["symbol"]))
        _UNIVERSE_CACHE = [r["symbol"] for r in eq]
    return _UNIVERSE_CACHE[offset:offset + limit]


def fetch_active_symbols(offset=0, limit=400):
    """Pull a slice of active symbols (kind=EQUITY only — ETFs use a separate
    cron, MFs come from AMFI). Ordered by `idx_tags desc, symbol asc` so
    Nifty 50/100 names get refreshed first when the cron runs.

    Falls back to the committed universe when dhan_instruments is empty --
    see _symbols_from_committed_universe for why it is."""
    url = (f"{SUPA_URL}/rest/v1/dhan_instruments"
           f"?select=symbol,idx_tags&is_active=eq.true&kind=eq.EQUITY"
           f"&order=idx_tags.desc,symbol.asc"
           f"&offset={offset}&limit={limit}")
    symbols = []
    try:
        req = urllib.request.Request(url, headers=_supa_headers({"Accept": "application/json"}))
        with urllib.request.urlopen(req, timeout=10) as r:
            symbols = [row["symbol"] for row in json.loads(r.read())]
    except Exception as exc:
        print(f"[sync-fundamentals] dhan_instruments read failed: {exc}", flush=True)

    if symbols:
        return symbols

    fallback = _symbols_from_committed_universe(offset, limit)
    if fallback:
        print(f"[sync-fundamentals] dhan_instruments empty at offset={offset}; "
              f"using committed universe ({len(fallback)} symbols)", flush=True)
    return fallback


def fetch_queue_symbols(limit):
    """Stalest-first slice from public.fundamentals_refresh_queue. [] on any
    failure, so the caller can fall back to the committed universe."""
    url = f"{SUPA_URL}/rest/v1/rpc/fundamentals_refresh_queue"
    body = json.dumps({"p_limit": int(limit)}).encode("utf-8")
    try:
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers=_supa_headers({"Accept": "application/json"}))
        with urllib.request.urlopen(req, timeout=10) as r:
            return [row["symbol"] for row in json.loads(r.read()) if row.get("symbol")]
    except Exception as exc:
        print(f"[sync-fundamentals] refresh queue read failed: {exc}", flush=True)
        return []


def record_attempts(results):
    """Upsert (symbol, attempted_at, ok) for every symbol this page touched."""
    if not (SUPA_URL and SUPA_SRV) or not results:
        return 0
    now = datetime.now(timezone.utc).isoformat()
    rows = [{"symbol": s, "attempted_at": now, "ok": ok} for s, ok in results]
    url = f"{SUPA_URL}/rest/v1/fundamentals_sync_attempts"
    headers = _supa_headers({"Prefer": "resolution=merge-duplicates,return=minimal"})
    try:
        req = urllib.request.Request(url, data=json.dumps(rows).encode("utf-8"),
                                     headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()
        return len(rows)
    except Exception as exc:
        print(f"[sync-fundamentals] recording attempts failed: {exc}", flush=True)
        return 0


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

    budget = Budget()
    # 1) Warm sid cache from DB so we skip search round-trips for known stocks.
    if warm_sid_cache:
        warm_sid_cache(fetch_known_sids())

    # 2) Pull the symbol slice: stalest first, else the committed universe.
    source = "queue"
    symbols = fetch_queue_symbols(limit)
    if not symbols:
        source = "fallback"
        symbols = fetch_active_symbols(offset=offset, limit=limit)
    if not symbols:
        return {"ok": True, "processed": 0, "offset": offset, "limit": limit,
                "next_offset": None, "source": source}

    # 3) Refresh each. fetch_fundamentals(allow_cache=False) skips the DB
    #    read but write_back=True still upserts the new row. This always
    #    pulls fresh upstream data.
    success = 0
    failed = 0
    attempts = []
    for sym in symbols:
        # Stop before the platform does. A killed function returns an HTML
        # page and the caller can't tell how far we got.
        if not budget.can_start():
            break
        ok = False
        try:
            r = fetch_fundamentals(sym, allow_cache=False, write_back=True)
            ok = bool(r and not r.get("error") and (r.get("market_cap") is not None or r.get("pe_ratio") is not None))
        except Exception:
            ok = False
        if ok:
            success += 1
        else:
            failed += 1
        attempts.append((sym, ok))
        # Soft throttle.
        time.sleep(INTER_REQUEST_DELAY_MS / 1000.0)
    recorded = record_attempts(attempts)

    # 4) Persist any new sid mappings the Tickertape calls picked up.
    new_sids = 0
    if get_sid_cache:
        new_sids = persist_sid_cache(get_sid_cache())

    # Advance by what was actually processed, never by the slice length: the
    # budget usually stops us well short of `limit`. Only meaningful for the
    # fallback path; the queue path ignores offset.
    processed = success + failed
    next_offset = offset + processed if processed else None

    return {
        "ok": True,
        "offset": offset,
        "limit": limit,
        "source": source,
        "processed": processed,
        "success": success,
        "failed": failed,
        "recorded": recorded,
        "new_sids": new_sids,
        "duration_ms": int(budget.elapsed() * 1000),
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
