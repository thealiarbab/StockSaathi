"""GET/POST /api/admin-warm-quotes — pre-warm public.quote_cache.

WHY THIS EXISTS

handlers/universe-quotes.py's own docstring describes its miss strategy as
"the warmer cron + per-symbol /api/live-quote". The warmer cron has never
existed. Measured 2026-09-14: of 3,655 rows in quote_cache only 379 were
fresh within 24h, and 2,473 were older than seven days. That is why
/api/universe-quotes — which is cache-ONLY and never fetches upstream —
returns mostly nulls.

WHAT THIS IS AND IS NOT FOR

It is a LATENCY feature, not a correctness one, and the distinction matters
because it sets the priority.

apply_trade and _fill_limit_order_core both price from quote_cache like this:

    select price_paise into v_ref_price from public.quote_cache where symbol = ...
    if v_ref_price is null or v_ref_price <= 0 then raise exception 'no price'

Note there is NO cached_at_ms check in either. They need the row to EXIST, not
to be fresh — a seven-day-old row satisfies them exactly as well as a
five-second-old one. So this warmer is not holding up trade correctness, and
it does not need a punctual scheduler. GitHub Actions being 3-15 minutes late,
which it routinely is, costs nothing here.

(Measured the same day: of 194 held symbols, 179 had a row and none was more
than 1 day stale, because admin-snapshot-portfolios.py already warms held
symbols as a side effect. The stale rows belong to symbols nobody holds.)

What it DOES buy: the coach's sector screening returns prices from cache in
~100ms instead of a cold Yahoo fan-out, and /api/universe-quotes stops
returning nulls.

TIERS — and why this is not "warm everything, often"

  a  ~300 symbols   held + pending-order + watchlist + Nifty100
  b  ~1,000 symbols every active equity carrying an index tag
  c  the rest       ~3,500 micro-caps

Warming all 4,619 every 5 minutes would be roughly 350,000 Yahoo requests a
day from IP ranges Yahoo already throttles (see the note in handlers/quote.py).
That does not degrade gracefully — it takes the price feed down for the WHOLE
app, not just the coach, and Yahoo is the only source: verified 2026-09-14
that DHAN_ACCESS_TOKEN is unset and every one of the 3,655 cached rows is
source='yahoo'. The tiering is a safety constraint, not an optimisation.

Auth (either accepted):
  Authorization: Bearer <ADMIN_TOKEN>
  Authorization: Bearer <CRON_SECRET>

Params:  tier=a|b|c (default a), offset=<int>, limit=<int, max 400>

Stdlib-only.
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _budget import Budget  # noqa: E402

SUPA_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_SRV = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()
CRON_SECRET = os.environ.get("CRON_SECRET", "").strip()
PUBLIC_ORIGIN = (os.environ.get("PUBLIC_ORIGIN") or "https://stocksaathi.co.in").rstrip("/")

# Warming by calling /api/live-quote means exactly one implementation of
# "fetch and cache a quote" exists — it owns the Yahoo fan-out, the thread
# pool and the cache write. Duplicating that here is how two paths drift.
#
# 40 rather than live-quote's 80-symbol ceiling: a chunk is all-or-nothing
# here, so one slow fan-out costs every symbol in it. The first run of this
# warmer lost exactly that way (118 warmed / 80 failed of 198). Halving the
# chunk halves the blast radius; the retry in _warm covers the rest.
BATCH = 40
MAX_LIMIT = 400


def _auth_ok(header):
    if not header or not header.startswith("Bearer "):
        return False
    tok = header[7:].strip()
    if not tok:
        return False
    ok = False
    for secret in (ADMIN_TOKEN, CRON_SECRET):
        if secret and len(tok) == len(secret):
            diff = 0
            for a, b in zip(tok, secret):
                diff |= ord(a) ^ ord(b)
            if diff == 0:
                ok = True
    return ok


def _supa_headers():
    return {
        "apikey": SUPA_SRV,
        "Authorization": f"Bearer {SUPA_SRV}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _supa_get(path_and_query, timeout=15):
    req = urllib.request.Request(
        f"{SUPA_URL}/rest/v1/{path_and_query}", headers=_supa_headers(), method="GET"
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8") or "[]")


def _tier_symbols(tier):
    """Resolve a tier to a de-duplicated, ordered symbol list."""
    syms = []
    if tier == "a":
        # The symbols where a missing row has user-visible consequences:
        # holdings (portfolio valuation), pending orders (the matcher prices
        # from this table), watchlist, plus the Nifty-100 that most questions
        # are about. idx_tags & 3 selects Nifty50 | Nifty100.
        for q in (
            "holdings?select=symbol",
            "limit_orders?select=symbol&status=eq.pending",
            "watchlist?select=symbol",
            "dhan_instruments?select=symbol&is_active=eq.true&kind=eq.EQUITY&idx_tags=gt.0&order=prominence.desc&limit=120",
        ):
            try:
                syms += [r["symbol"] for r in _supa_get(q) if r.get("symbol")]
            except Exception:
                continue
    elif tier == "b":
        try:
            syms = [
                r["symbol"]
                for r in _supa_get(
                    "dhan_instruments?select=symbol&is_active=eq.true&kind=eq.EQUITY"
                    "&idx_tags=gt.0&order=prominence.desc,symbol.asc&limit=1200"
                )
                if r.get("symbol")
            ]
        except Exception:
            syms = []
    else:  # tier c — everything else, weekend only in practice
        try:
            syms = [
                r["symbol"]
                for r in _supa_get(
                    "dhan_instruments?select=symbol&is_active=eq.true&kind=eq.EQUITY"
                    "&idx_tags=eq.0&order=symbol.asc&limit=4000"
                )
                if r.get("symbol")
            ]
        except Exception:
            syms = []

    # Mutual funds are priced from mf_master.nav, not quote_cache, so warming
    # them here would be a no-op that burns Yahoo requests.
    seen, out = set(), []
    for s in syms:
        if s and not s.startswith("MF_") and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _warm(symbols, budget):
    """Warm via /api/live-quote, which owns the fetch-and-cache path.

    One retry per chunk. A cold fan-out against Yahoo is genuinely slow
    sometimes, and without a retry a single slow batch silently costs every
    symbol in it — which is what happened on the first run (80 of 198 lost to
    one chunk). The retry is cheap because a partially-warmed chunk is already
    cached, so the second attempt mostly hits the cache and returns fast.

    Returns (warmed, failed, processed). `processed` can be short of
    len(symbols): once the budget says stop, no new chunk or retry starts.
    Without that, 6 chunks x (45s timeout + retry) ran straight through
    Vercel's limit on every cold-cache run and the caller got an HTML
    FUNCTION_INVOCATION_TIMEOUT page instead of a resumable answer.
    """
    warmed, failed, processed = 0, 0, 0
    for i in range(0, len(symbols), BATCH):
        if not budget.can_start():
            break
        chunk = symbols[i : i + BATCH]
        url = f"{PUBLIC_ORIGIN}/api/live-quote?symbols=" + urllib.parse.quote(",".join(chunk))
        got = None
        for attempt in (1, 2):
            if attempt == 2 and not budget.can_start():
                break
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "StockSaathi-Warmer/1.0"})
                with urllib.request.urlopen(req, timeout=budget.timeout(45)) as r:
                    payload = json.loads(r.read().decode("utf-8") or "{}")
                got = len(payload.get("quotes") or {})
                break
            except Exception:
                if attempt == 1:
                    time.sleep(1.5)
        processed += len(chunk)
        if got is None:
            failed += len(chunk)
        else:
            warmed += got
            # quotes may come back short of the chunk if a symbol has no
            # upstream data at all. Count the shortfall rather than pretending.
            failed += max(0, len(chunk) - got)
    return warmed, failed, processed


def _run(tier, offset, limit):
    budget = Budget()
    all_syms = _tier_symbols(tier)
    window = all_syms[offset : offset + limit]
    warmed, failed, processed = _warm(window, budget)
    next_offset = offset + processed
    return {
        "ok": True,
        "tier": tier,
        "offset": offset,
        "limit": limit,
        "tierTotal": len(all_syms),
        "attempted": processed,
        "warmed": warmed,
        "failed": failed,
        # Callers must follow nextOffset, not offset+limit: the handler stops
        # itself before Vercel's maxDuration and may return short of `limit`.
        "nextOffset": next_offset,
        "more": next_offset < len(all_syms),
        "durationMs": int(budget.elapsed() * 1000),
    }


class handler(BaseHTTPRequestHandler):
    def _respond(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle(self):
        if not _auth_ok(self.headers.get("Authorization")):
            return self._respond(401, {"ok": False, "error": "unauthorized"})
        if not (SUPA_URL and SUPA_SRV):
            return self._respond(500, {"ok": False, "error": "supabase_not_configured"})
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        tier = (qs.get("tier", ["a"])[0] or "a").lower()
        if tier not in ("a", "b", "c"):
            return self._respond(400, {"ok": False, "error": "bad_tier"})
        try:
            offset = max(0, int(qs.get("offset", ["0"])[0]))
            limit = min(MAX_LIMIT, max(1, int(qs.get("limit", ["240"])[0])))
        except ValueError:
            return self._respond(400, {"ok": False, "error": "bad_paging"})
        try:
            self._respond(200, _run(tier, offset, limit))
        except Exception as e:
            self._respond(500, {"ok": False, "error": str(e)[:200]})

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()
