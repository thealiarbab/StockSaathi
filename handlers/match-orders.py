"""GET/POST /api/match-orders — SERVER-SIDE limit / AMO order matcher.

WHY THIS EXISTS
---------------
Order execution used to be client-driven. `js/features/limitOrders.js` ran a
12-second polling loop in the USER'S OWN BROWSER TAB and refused to act unless
`marketStatus().open`. There was no server-side counterpart anywhere in the
stack: no pg_cron, no pg_net, no Supabase Edge Function, no Vercel cron.

An order therefore filled only while the user personally had StockSaathi open,
on a weekday, between 09:15 and 15:30 IST. For a product aimed at 13-18 year
olds that window is the school day. One affected user asked, in the very
thread where he was chasing a stuck order: "Yaar me 8 se 2 baje busy rahta hu
to trading kaise karu". By 2026-09-13 that had produced 75 pending orders, 42
of them already past their fill condition, the oldest untouched for 87 days,
with the users' cash reserved the entire time.

This endpoint is the fix. It runs on a schedule, independent of any browser.
The user can close the tab, uninstall the PWA, throw the phone in a lake —
their orders still execute.

AUTH
----
    Authorization: Bearer <CRON_SECRET>    (scheduled callers)
 or Authorization: Bearer <ADMIN_TOKEN>    (manual trigger)

QUERY PARAMS
------------
    force=1      run even when the NSE is closed (manual / backfill use)
    dry=1        report what WOULD fill, change nothing
    backfill=1   fill every matchable order at its own FROZEN limit price
                 rather than at the live market price. Used once, to make
                 good on the orders the client-only matcher never executed.
                 Requires ADMIN_TOKEN — CRON_SECRET is not enough.

SCHEDULING
----------
Called every minute during market hours by the Cloudflare front-door Worker's
cron trigger, and every 5 minutes by .github/workflows/order-matcher.yml as a
belt-and-braces backup. Both paths are idempotent: `fill_limit_order` flips
status to 'filled' inside a row-locked transaction, so a double call is a
no-op rather than a double fill.
"""

import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

try:
    from zoneinfo import ZoneInfo
    _IST = ZoneInfo("Asia/Kolkata")
except Exception:
    _IST = None

_DIR = pathlib.Path(__file__).resolve().parent
if str(_DIR) not in sys.path:
    sys.path.insert(0, str(_DIR))

SUPA_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_SRV = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()
CRON_SECRET = os.environ.get("CRON_SECRET", "").strip()

# Cap work per invocation so a cold cache can't blow the 60 s function budget.
# Was 300 with 295 pending on 17 Oct 2026 and 100+ signups a day: orders past
# the cap (newest first to be cut) would never have been looked at.
MAX_ORDERS_PER_RUN = 3000
MAX_SYMBOLS_PER_BATCH = 60

# NSE trading holidays — parsed from js/data/nseCalendar.js at runtime so there is
# exactly ONE list in the codebase.
#
# This started as a hand-written copy and immediately drifted: the two
# disagreed on 8 dates. The dangerous direction is a day the client treats as
# a holiday but the matcher does not — 2026-09-14 (Ganesh Chaturthi) was
# exactly that, so the matcher would have woken up on a closed exchange,
# fetched the previous session's stale closes, and filled live orders against
# them. That is the same failure the client matcher's own comments describe as
# "queued orders vanish on /#/portfolio".
#
# The shared calendar ships with every deploy, so parsing it costs nothing and
# cannot drift. The literal below is only a last-resort fallback and is
# asserted equal to the shared calendar by api-backup/tests/test_order_execution_guards.py.
_HOLIDAY_FALLBACK = {
    "2026-01-15", "2026-01-26", "2026-02-15", "2026-03-03", "2026-03-21",
    "2026-03-26", "2026-03-31", "2026-04-03", "2026-04-14", "2026-05-01",
    "2026-05-28", "2026-06-26", "2026-08-15", "2026-09-14", "2026-10-02",
    "2026-10-20", "2026-11-08", "2026-11-10", "2026-11-24", "2026-12-25",
}

_holidays_cache = None


def nse_holidays():
    global _holidays_cache
    if _holidays_cache is not None:
        return _holidays_cache
    try:
        src = (_DIR.parent / "js" / "data" / "nseCalendar.js").read_text(encoding="utf-8")
        found = set(re.findall(r'^\s*"(\d{4}-\d{2}-\d{2})"\s*:', src, re.MULTILINE))
        _holidays_cache = found or set(_HOLIDAY_FALLBACK)
    except Exception:
        _holidays_cache = set(_HOLIDAY_FALLBACK)
    return _holidays_cache


def _auth_ok(header):
    """Mirrors the admin-sync handlers. Returns (ok, is_admin)."""
    if not header:
        return (False, False)
    m = re.match(r"^Bearer\s+(.+)$", header.strip(), re.I)
    token = (m.group(1) if m else header).strip()
    if not token:
        return (False, False)
    is_admin = bool(ADMIN_TOKEN) and token == ADMIN_TOKEN
    ok = is_admin or (bool(CRON_SECRET) and token == CRON_SECRET)
    return (ok, is_admin)


def _supa_headers():
    return {
        "apikey": SUPA_SRV,
        "Authorization": f"Bearer {SUPA_SRV}",
        "Content-Type": "application/json",
    }


def _rpc(name, payload, timeout=10):
    """Call a Postgres RPC as the service role. Returns (ok, parsed_or_error)."""
    if not (SUPA_URL and SUPA_SRV):
        return (False, "supabase not configured")
    url = f"{SUPA_URL}/rest/v1/rpc/{name}"
    body = json.dumps(payload or {}).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=_supa_headers(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8")
        return (True, json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        try:
            return (False, e.read().decode("utf-8")[:300])
        except Exception:
            return (False, f"HTTP {e.code}")
    except Exception as e:
        return (False, str(e)[:200])


def market_state():
    """('open'|'closed', reason). Mirrors js/data/prices.js marketStatus()."""
    if _IST is None:
        return ("closed", "no_tz")
    now = datetime.now(tz=_IST)
    if now.weekday() >= 5:
        return ("closed", "weekend")
    if now.strftime("%Y-%m-%d") in nse_holidays():
        return ("closed", "holiday")
    mins = now.hour * 60 + now.minute
    if (9 * 60 + 15) <= mins < (15 * 60 + 30):
        return ("open", "")
    return ("closed", "outside_hours")


# ---------------------------------------------------------------------------
# Pricing. Equities go through the existing /api/live-quote module (imported
# in-process, no network hop) so the matcher inherits its cache -> Dhan ->
# Yahoo fall-through. Mutual funds have no intraday price at all: they are
# marked to the daily NAV in mf_master.
# ---------------------------------------------------------------------------

def _load_live_quote():
    import importlib.util
    key = "ss_handler_live_quote"
    cached = sys.modules.get(key)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(key, _DIR / "live-quote.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[key] = mod
    spec.loader.exec_module(mod)
    return mod


def equity_prices(symbols, ts_out=None):
    """{symbol: price_paise} for equity/ETF symbols. Best effort.

    ts_out, if given, is filled with {symbol: market_time_ms} for each price.
    """
    out = {}
    if ts_out is None:
        ts_out = {}
    if not symbols:
        return out
    try:
        lq = _load_live_quote()
    except Exception:
        return out

    remaining = list(symbols)
    # Cache first, but only very recent rows — matching against a months-old
    # cached close is exactly the failure mode that made queued orders vanish
    # in the old client matcher.
    try:
        cached = lq.read_cache(remaining, ttl_ms=90_000) or {}
        for sym, row in cached.items():
            if row.get("price_paise"):
                out[sym] = int(row["price_paise"])
                ts_out[sym] = int(row.get("ts_ms") or 0)
        remaining = [s for s in remaining if s not in out]
    except Exception:
        pass

    for i in range(0, len(remaining), MAX_SYMBOLS_PER_BATCH):
        chunk = remaining[i:i + MAX_SYMBOLS_PER_BATCH]
        fetched = {}
        try:
            fetched = lq.fetch_dhan_ltp(chunk) or {}
        except Exception:
            fetched = {}
        missing = [s for s in chunk if s not in fetched]
        if missing:
            try:
                fetched.update(lq.fetch_yahoo_batch(missing) or {})
            except Exception:
                pass
        rows = []
        for sym, q in fetched.items():
            try:
                out[sym] = int(round(float(q["price"]) * 100))
                ts_out[sym] = int(q.get("ts_ms") or 0)
                rows.append(lq._to_cache_row(q))
            except Exception:
                continue
        if rows:
            try:
                lq.write_cache(rows)
            except Exception:
                pass

    # No end-of-day fallback here. A limit is only "touched" by a live price:
    # matching against the exchange's previous close filled SME orders at
    # yesterday's price (24 trades outside the day's real range, Oct 2026),
    # and _fill_limit_order_core now refuses it anyway. Those stocks are
    # matched by the end-of-day sweep against the day's real high/low.
    return out


_mf_static_cache = None


def _mf_static_navs():
    """{symbol: nav_paise} parsed from the shipped js/data/mfFull.json.

    This is the SAME file the browser prices mutual funds from, so the
    matcher and the UI can never disagree about a fund's NAV. It is also
    why MF matching does not depend on a cron: the file is deployed with
    the app. mf_master in Postgres is the nominally-canonical source but
    has been sitting at 0 rows because the nightly data-sync aborts on an
    unrelated instrument-sync failure before it ever reaches the MF step.
    Relying on it alone would have left every mutual-fund order unfillable.
    """
    global _mf_static_cache
    if _mf_static_cache is not None:
        return _mf_static_cache
    _mf_static_cache = {}
    path = _DIR.parent / "js" / "data" / "mfFull.json"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        rows = data if isinstance(data, list) else (data.get("rows") or data.get("data") or [])
        for row in rows:
            sym, nav = row.get("symbol"), row.get("nav")
            if sym and nav:
                try:
                    _mf_static_cache[sym] = int(round(float(nav) * 100))
                except Exception:
                    continue
    except Exception:
        pass
    return _mf_static_cache


def mf_prices(symbols, dates_out=None):
    """{symbol: nav_paise} for MF_<code> symbols. mf_master first, then the
    shipped AMFI snapshot for anything it does not cover.

    dates_out, if given, is filled with {symbol: "YYYY-MM-DD"} from mf_master
    (the date the fill core checks against the order's nav_from_date).
    """
    out = {}
    if dates_out is None:
        dates_out = {}
    if not symbols:
        return out
    if SUPA_URL and SUPA_SRV:
        for i in range(0, len(symbols), MAX_SYMBOLS_PER_BATCH):
            chunk = symbols[i:i + MAX_SYMBOLS_PER_BATCH]
            sym_list = ",".join(f'"{s}"' for s in chunk)
            url = (f"{SUPA_URL}/rest/v1/mf_master"
                   f"?symbol=in.({sym_list})&select=symbol,nav,nav_date")
            req = urllib.request.Request(url, headers=_supa_headers())
            try:
                with urllib.request.urlopen(req, timeout=6) as r:
                    for row in json.loads(r.read().decode("utf-8")):
                        nav = row.get("nav")
                        if nav:
                            out[row["symbol"]] = int(round(float(nav) * 100))
                            if row.get("nav_date"):
                                dates_out[row["symbol"]] = row["nav_date"]
            except Exception:
                continue
    missing = [s for s in symbols if s not in out]
    if missing:
        static = _mf_static_navs()
        for s in missing:
            if s in static:
                out[s] = static[s]
    return out


# ---------------------------------------------------------------------------
# The matcher
# ---------------------------------------------------------------------------

def run_match(force=False, dry=False, backfill=False):
    started = time.time()
    state, reason = market_state()
    if state != "open" and not force:
        return {"ok": True, "skipped": "market_closed", "reason": reason,
                "checked": 0, "filled": 0}

    ok, orders = _rpc("admin_pending_orders", {})
    if not ok:
        return {"ok": False, "error": f"admin_pending_orders: {orders}"}
    orders = orders or []
    if not orders:
        return {"ok": True, "checked": 0, "filled": 0, "market": state}

    orders = orders[:MAX_ORDERS_PER_RUN]
    symbols = sorted({o["symbol"] for o in orders})
    mf_syms = [s for s in symbols if s.startswith("MF_")]
    eq_syms = [s for s in symbols if not s.startswith("MF_")]

    prices, px_ts, nav_dates = {}, {}, {}
    prices.update(equity_prices(eq_syms, px_ts))
    prices.update(mf_prices(mf_syms, nav_dates))
    # Today's 09:15 IST in ms. The fill core refuses any equity price older
    # than that (_quote_not_live_reason), so asking it is a wasted call.
    open_ms = 0
    if _IST is not None:
        _now = datetime.now(tz=_IST)
        open_ms = int(_now.replace(hour=9, minute=15, second=0, microsecond=0).timestamp() * 1000)

    filled, skipped, no_price, errors, closed = [], 0, [], [], []
    for o in orders:
        px = prices.get(o["symbol"])
        if not px:
            # NO auto-cancel here. The old client matcher cancelled an order
            # after ~2 minutes of missing quotes, which silently killed every
            # mutual-fund order (getQuoteBatch has no MF coverage) and any
            # thinly-covered listing. A missing price is our problem, not the
            # user's: leave the order pending and try again next tick.
            no_price.append(o["symbol"])
            continue
        limit = int(o["limit_price_paise"])
        side = o["side"]
        otype = o.get("order_type") or "LIMIT"
        if otype in ("AMO_MARKET", "MF"):
            # No price condition: an order at the open takes the first live
            # price, a fund order the next published NAV. The fill core
            # checks freshness / NAV date and says "wait" otherwise.
            matches = True
        else:
            matches = (px <= limit) if side == "BUY" else (px >= limit)
        if backfill:
            # Make good at the price the user was promised when they placed
            # the order, not at whatever the market has drifted to since.
            matches = True
            px = limit
        if not matches:
            skipped += 1
            continue
        # Pre-checks that mirror _fill_limit_order_core's own refusals. On
        # 16 Oct 2026 3,114 of 3,204 fill calls came back refused: fund orders
        # asked every minute before their NAV was out, and orders on stocks
        # that had not traded yet that day. The core still has the final say.
        if not backfill:
            if otype == "MF" or o["symbol"].startswith("MF_"):
                need, have = o.get("nav_from_date"), nav_dates.get(o["symbol"])
                if not have or (need and have < need):
                    no_price.append(o["symbol"])
                    continue
            elif px_ts.get(o["symbol"], 0) < open_ms:
                no_price.append(o["symbol"])
                continue
        if dry:
            filled.append({"order_id": o["id"], "symbol": o["symbol"],
                           "side": side, "at_paise": px, "dry": True})
            continue
        ok2, res = _rpc("admin_fill_limit_order", {
            "p_order_id": o["id"],
            "p_market_paise": px,
            "p_enforce_limit": not backfill,
        })
        if ok2 and isinstance(res, dict) and res.get("ok"):
            filled.append({"order_id": o["id"], "symbol": o["symbol"],
                           "side": side, "user_id": res.get("user_id"),
                           "fill_price": res.get("fill_price")})
        elif ok2 and isinstance(res, dict) and res.get("reason"):
            # Closed by the fill core itself (a queued SELL for shares the
            # user no longer holds); the user got a notice.
            closed.append({"order_id": o["id"], "symbol": o["symbol"], "reason": res.get("reason")})
        else:
            msg = str(res)
            # 'already filled' just means another tick won the race; 'no
            # fresh price' means the quote went stale between the fetch and
            # the fill: retry next tick like any other missing price.
            if "no fresh price" in msg or "nav not yet published" in msg:
                no_price.append(o["symbol"])
            elif "already" not in msg:
                errors.append({"order_id": o["id"], "symbol": o["symbol"], "error": msg[:160]})

    return {
        "ok": True,
        "market": state,
        "forced": bool(force),
        "backfill": bool(backfill),
        "dry": bool(dry),
        "checked": len(orders),
        "filled": len(filled),
        "waiting": skipped,
        "no_price_symbols": sorted(set(no_price))[:40],
        "errors": errors[:20],
        "closed": closed[:20],
        "fills": filled[:60],
        "elapsed_ms": int((time.time() - started) * 1000),
    }


class handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.end_headers()

    def do_POST(self):
        self.do_GET()

    def do_GET(self):
        ok, is_admin = _auth_ok(self.headers.get("Authorization"))
        if not ok:
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        qs = parse_qs(urlparse(self.path).query)
        force = qs.get("force", ["0"])[0] == "1"
        dry = qs.get("dry", ["0"])[0] == "1"
        backfill = qs.get("backfill", ["0"])[0] == "1"
        if backfill and not is_admin:
            self._send(403, {"ok": False,
                             "error": "backfill requires ADMIN_TOKEN, not CRON_SECRET"})
            return
        try:
            self._send(200, run_match(force=force, dry=dry, backfill=backfill))
        except Exception as e:
            self._send(500, {"ok": False, "error": str(e)[:300]})

    def log_message(self, *_args):
        pass
