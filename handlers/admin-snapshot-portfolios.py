"""GET/POST /api/admin-snapshot-portfolios — daily mark-to-market portfolio snapshot.

Writes one `portfolio_history` row per trading user, valuing their holdings at
LIVE prices, so the "Value over time" chart on #/portfolio actually moves.

WHY THIS EXISTS
---------------
Until 2026-09-13 the only writer to portfolio_history was
trg_transaction_portfolio_snapshot, which fires on each trade and values
holdings at COST BASIS (qty * avg_cost_paise). Cost basis makes a BUY
value-neutral — Rs X of cash becomes Rs X of stock — so a buy-and-hold
user's entire series is a dead-flat line at their starting cash. It cannot
express a gain or a loss. 11 of the 42 users with history had exactly that.

The valuation therefore has to happen where live prices live, which is here,
not in Postgres. quote_cache is NOT a substitute: it is a demand-filled TTL
cache, and only 1 of 128 currently-held symbols had a quote fresher than
7 days. Valuing from it would stamp April prices as today's number.

FLOW
----
  1. Read every distinct symbol held by anyone (service role, one request).
  2. Price them through the same chain /api/live-quote uses:
        Dhan REST -> Yahoo v8/chart
     Reuses that module's functions rather than duplicating the fallback
     logic, so there is one place where pricing behaviour is defined.
  3. Warm quote_cache with whatever came back (free side benefit).
  4. Hand the symbol -> paise map to admin_portfolio_snapshot_mtm(jsonb),
     which writes one daily_snapshot per trading user. Symbols we could not
     price fall back to cost basis inside the RPC.

Mutual funds (MF_* symbols) have no quote coverage — getQuoteBatch has never
had any, which is the same gap that made the old client-side matcher destroy
every MF order. They are skipped here and fall back to cost basis rather than
being dropped from the portfolio value.

IDEMPOTENT: the RPC skips any user who already has a daily_snapshot today, so
re-running (or two schedulers overlapping) cannot double-write.

Auth: Authorization: Bearer <ADMIN_TOKEN>   (manual trigger)
   OR Authorization: Bearer <CRON_SECRET>   (scheduled callers)
"""

import importlib.util
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler

_DIR = pathlib.Path(__file__).resolve().parent
if str(_DIR) not in sys.path:
    sys.path.insert(0, str(_DIR))

SUPA_URL    = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_SRV    = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()
CRON_SECRET = os.environ.get("CRON_SECRET", "").strip()

# Yahoo is fetched with a 40-way thread pool and an 8s as_completed timeout
# inside live-quote. Keep the symbol count bounded so a pathological universe
# cannot push the function past Vercel's 60s maxDuration.
MAX_SYMBOLS = 400


def _supa_headers(extra=None):
    h = {
        "apikey": SUPA_SRV,
        "Authorization": f"Bearer {SUPA_SRV}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def _auth_ok(authz_header):
    """Length-checked, constant-time-ish compare against either accepted token."""
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


def _live_quote_module():
    """Load handlers/live-quote.py, reusing _shim.py's cache key so the module
    is not parsed twice when both routes are hit in one warm container."""
    key = "ss_handler_live_quote"
    cached = sys.modules.get(key)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(key, _DIR / "live-quote.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[key] = mod
    spec.loader.exec_module(mod)
    return mod


def _held_symbols():
    """Every distinct symbol held by any user. PostgREST has no DISTINCT, so
    we pull the column and dedupe here — it is a few hundred short strings."""
    url = f"{SUPA_URL}/rest/v1/holdings?select=symbol&qty=gt.0"
    req = urllib.request.Request(url, headers=_supa_headers())
    with urllib.request.urlopen(req, timeout=15) as r:
        rows = json.loads(r.read().decode("utf-8"))
    seen = []
    seen_set = set()
    for row in rows:
        s = (row.get("symbol") or "").strip()
        if s and s not in seen_set:
            seen_set.add(s)
            seen.append(s)
    return seen


def _price_symbols(symbols):
    """symbol -> price in PAISE, via the same chain /api/live-quote uses.

    Symbols that cannot be priced are simply absent from the returned map;
    the RPC falls back to cost basis for those.
    """
    lq = _live_quote_module()
    quotes = {}

    # Dhan first when configured — it is the real-time source; Yahoo is the
    # rate-limited fallback that Vercel IPs frequently get throttled on.
    try:
        if getattr(lq, "DHAN_TOKEN", "") and getattr(lq, "DHAN_CLIENT", ""):
            quotes.update(lq.fetch_dhan_ltp(symbols) or {})
    except Exception as e:
        print(f"[snapshot] dhan leg failed, falling through to yahoo: {e}")

    missing = [s for s in symbols if s not in quotes]
    if missing:
        try:
            quotes.update(lq.fetch_yahoo_batch(missing) or {})
        except Exception as e:
            print(f"[snapshot] yahoo leg failed: {e}")

    prices = {}
    cache_rows = []
    for sym, q in quotes.items():
        try:
            paise = int(round(float(q["price"]) * 100))
        except Exception:
            continue
        if paise <= 0:
            continue
        prices[sym] = paise
        try:
            cache_rows.append(lq._to_cache_row(q))
        except Exception:
            pass

    # Warm quote_cache with what we just paid for. Best-effort: a failed
    # cache write must never fail the snapshot.
    if cache_rows:
        try:
            lq.write_cache(cache_rows)
        except Exception as e:
            print(f"[snapshot] quote_cache warm failed (non-fatal): {e}")

    return prices, {"requested": len(symbols), "priced": len(prices)}


def _call_rpc(prices):
    url = f"{SUPA_URL}/rest/v1/rpc/admin_portfolio_snapshot_mtm"
    body = json.dumps({"p_prices": prices}).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=_supa_headers(), method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def run_snapshot():
    t0 = time.time()
    if not SUPA_URL or not SUPA_SRV:
        return {"ok": False, "error": "supabase_not_configured"}

    symbols = _held_symbols()
    # MF_* have no quote coverage anywhere in the stack. Excluded from the
    # price fetch so we do not burn 8s of Yahoo timeouts on certain misses;
    # the RPC values them at cost basis instead of dropping them.
    quotable = [s for s in symbols if not s.startswith("MF_")][:MAX_SYMBOLS]
    mf_count = len(symbols) - len([s for s in symbols if not s.startswith("MF_")])

    prices, stats = _price_symbols(quotable)
    rpc = _call_rpc(prices)

    return {
        "ok": True,
        "symbols_held": len(symbols),
        "symbols_quotable": len(quotable),
        "symbols_mf_cost_basis": mf_count,
        "symbols_priced": stats["priced"],
        "rpc": rpc,
        "elapsed_ms": int((time.time() - t0) * 1000),
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
        try:
            return self._reply(200, run_snapshot())
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8")[:400]
            except Exception:
                pass
            return self._reply(502, {"ok": False, "error": "upstream_failed",
                                     "status": e.code, "detail": detail})
        except Exception as e:
            return self._reply(500, {"ok": False, "error": "snapshot_failed",
                                     "detail": str(e)[:400]})

    def do_GET(self):  self._run()
    def do_POST(self): self._run()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.end_headers()
