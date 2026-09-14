"""GET/POST /api/admin-sync-instruments — instrument master sync.

Upserts the NSE equity + ETF universe into Supabase public.dhan_instruments
via service-role, from the committed js/data/universeFull.json artifact.
Soft-deletes any symbol present in the DB but absent from the artifact (sets
is_active=false rather than deleting, so historical holdings keep their
references).

IT NO LONGER FETCHES FROM NSE, AND THAT IS THE POINT.

Until 2026-09-14 this handler fetched EQUITY_L.csv from nseindia.com directly.
NSE blocks Vercel's IP range, so that fetch failed on every single run for
months — the endpoint returned HTTP 500 with "sanity_fail: only 0 equities
(expected >=1800)" and public.dhan_instruments sat at 0 rows for its entire
life. The error was honest; the approach was impossible from this runtime.

.github/workflows/universe-refresh.yml already fetches the same data daily and
SUCCEEDS, because GitHub-hosted runners are not blocked, then commits it to
js/data/universeFull.json. So the data was always one step from the database
and nothing carried it across. This handler is that step: it reads the artifact
out of its own deployment, which cannot be blocked by anyone.

Auth (either accepted):
  Authorization: Bearer <ADMIN_TOKEN>     # manual trigger via /api/ai
  Authorization: Bearer <CRON_SECRET>     # scheduler

Stdlib-only — no requirements.txt entry needed.
"""

import io
import json
import os
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler

# ── env ─────────────────────────────────────────────────────────────────────
SUPA_URL    = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_SRV    = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()
CRON_SECRET = os.environ.get("CRON_SECRET", "").strip()

# ── browser-like session (NSE/niftyindices 403 anything else) ───────────────
# ── CSV helpers ─────────────────────────────────────────────────────────────
def _stripq(s):
    return (s or "").strip().strip('"')

# ── sector taxonomy (mirrors build-universe.mjs NSE_TO_SS_SECTOR) ───────────
NSE_TO_SS = {
    "Banks": "Banking", "Financial Services": "NBFC", "Insurance": "Insurance",
    "Financial Institutions": "NBFC", "Capital Markets": "NBFC",
    "Oil Gas & Consumable Fuels": "Energy", "Oil & Gas": "Energy", "Power": "Power",
    "Utilities": "Power",
    "Information Technology": "IT Services", "IT - Software": "IT Services",
    "Telecom - Services": "Telecom", "Telecommunication": "Telecom",
    "Fast Moving Consumer Goods": "FMCG", "Food Beverages & Tobacco": "FMCG",
    "Consumer Durables": "Consumer Elec",
    "Consumer Services": "Consumer", "Retailing": "Retail", "Realty": "Real Estate",
    "Metals & Mining": "Metals", "Cement & Cement Products": "Cement",
    "Construction Materials": "Cement", "Chemicals": "Chemicals",
    "Construction": "Construction", "Capital Goods": "Infrastructure",
    "Automobile and Auto Components": "Auto",
    "Automobiles & Auto Components": "Auto",
    "Healthcare": "Healthcare", "Pharmaceuticals": "Pharma",
    "Services": "Services", "Transport Services": "Services",
    "Transport Infrastructure": "Infrastructure",
    "Media Entertainment & Publication": "Services",
    "Forest Materials": "Other", "Paper Forest & Jute Products": "Other",
    "Textiles": "Other", "Diversified": "Conglomerate",
}
# ── idx bitmask + classifiers ───────────────────────────────────────────────
IDX_N50, IDX_N100, IDX_N500 = 1<<0, 1<<1, 1<<2
IDX_MID150, IDX_SMALL250    = 1<<3, 1<<4

# ── Supabase helpers ────────────────────────────────────────────────────────
def _supa_headers(extra=None):
    h = {
        "apikey": SUPA_SRV,
        "Authorization": f"Bearer {SUPA_SRV}",
        "Content-Type": "application/json",
    }
    if extra: h.update(extra)
    return h

def _supa_get_active_symbols():
    url = f"{SUPA_URL}/rest/v1/dhan_instruments?select=symbol&is_active=eq.true&limit=20000"
    req = urllib.request.Request(url, headers=_supa_headers())
    with urllib.request.urlopen(req, timeout=10) as r:
        return {row["symbol"] for row in json.loads(r.read())}

def _supa_upsert_chunked(rows, chunk=500):
    url = f"{SUPA_URL}/rest/v1/dhan_instruments"
    headers = _supa_headers({"Prefer": "resolution=merge-duplicates,return=minimal"})
    total = 0
    for i in range(0, len(rows), chunk):
        body = json.dumps(rows[i:i+chunk]).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=20) as r:
            r.read()
        total += min(chunk, len(rows) - i)
    return total

def _supa_deactivate(symbols):
    if not symbols: return 0
    deactivated = 0
    headers = _supa_headers({"Prefer": "return=minimal"})
    syms = list(symbols)
    for i in range(0, len(syms), 200):
        sub = syms[i:i+200]
        in_list = ",".join(f'"{s}"' for s in sub)
        url = f"{SUPA_URL}/rest/v1/dhan_instruments?symbol=in.({in_list})"
        body = json.dumps({"is_active": False}).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=headers, method="PATCH")
        with urllib.request.urlopen(req, timeout=15) as r:
            r.read()
        deactivated += len(sub)
    return deactivated

# ── auth (constant-time-ish) ────────────────────────────────────────────────
def _auth_ok(authz_header):
    if not authz_header: return False
    raw = authz_header
    if raw.lower().startswith("bearer "):
        raw = raw[7:]
    raw = raw.strip()
    if not raw: return False
    for expected in (ADMIN_TOKEN, CRON_SECRET):
        if not expected: continue
        if len(raw) != len(expected): continue
        diff = 0
        for a, b in zip(raw, expected):
            diff |= ord(a) ^ ord(b)
        if diff == 0: return True
    return False

# ── core sync ───────────────────────────────────────────────────────────────
def _load_universe_json():
    """Read the committed js/data/universeFull.json out of the deployment.

    Path resolution mirrors handlers/screener.py: the relative location depends
    on the runtime cwd, which differs between the Vercel bundle (/var/task),
    the local dev server, and the Fly.io backup image.
    """
    candidates = [
        os.path.join(os.path.dirname(__file__), "..", "js", "data", "universeFull.json"),
        os.path.join(os.getcwd(), "js", "data", "universeFull.json"),
        os.path.join("/var/task", "js", "data", "universeFull.json"),
    ]
    for c in candidates:
        try:
            with open(c, "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            continue
    raise RuntimeError("universeFull.json not found in the deployment")


# dhan_instruments_kind_check allows EQUITY | ETF | BOND only. Mutual funds have
# their own table (mf_master); merging them here would fail the constraint and
# reject the entire chunk.
_ALLOWED_KINDS = {"EQUITY", "ETF", "BOND"}
_EXCHANGE_SEGMENT = {"NSE": "NSE_EQ", "NSE_SME": "NSE_EQ", "BSE": "BSE_EQ"}


def _run_sync():
    """Push the committed universe artifact into public.dhan_instruments.

    HISTORY - this function used to fetch EQUITY_L.csv from NSE directly, and
    that is why the table has been empty for its entire life. NSE blocks
    Vercel's IP range, so the fetch failed and the sanity gate below tripped
    ("only 0 equities") on every single run for months. The failure was real
    and correctly reported; the approach was simply impossible from here.

    Meanwhile .github/workflows/universe-refresh.yml already fetches exactly
    this data every day and succeeds, because GitHub-hosted runners are NOT
    blocked, and commits it to js/data/universeFull.json. The data has always
    been one step from the database. This reads that artifact instead, so the
    sync runs entirely on data that is already in the deployment - no outbound
    NSE call, nothing that can be blocked.

    The sanity gate, upsert and deactivate paths below are unchanged.
    """
    t0 = time.time()
    rows = _load_universe_json()
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("universeFull.json is empty or not a list")

    out, seen = [], set()
    for r in rows:
        sym = _stripq(r.get("symbol"))
        if not sym or sym in seen:
            continue
        kind = str(r.get("kind") or "EQUITY").upper()
        if kind not in _ALLOWED_KINDS:
            continue
        seen.add(sym)
        out.append({
            "symbol":     sym,
            "name":       _stripq(r.get("name")) or sym,
            # Empty string -> NULL. ETFs carry no ISIN in the artifact, and an
            # empty string in a nullable text column is a third state nobody
            # checks for ("" is falsy in JS but NOT NULL in SQL).
            "series":     _stripq(r.get("series")) or None,
            "isin":       _stripq(r.get("isin")) or None,
            "idx_tags":   int(r.get("idx") or 0),
            "sector":     r.get("sector"),
            "cap_bucket": r.get("capBucket"),
            "risk_tier":  r.get("risk"),
            "lot_size":   int(r.get("lot") or 1),
            "kind":       kind,
            "exchange_segment": _EXCHANGE_SEGMENT.get(r.get("exchange"), "NSE_EQ"),
            "is_active":  True,
            # security_id is deliberately omitted, not set to None. PostgREST
            # writes only the keys present in the body, so leaving it out
            # preserves whatever a future Dhan sync writes there. Sending None
            # would stamp null over it. Note this sync cannot populate it:
            # Dhan ids come from api-scrip-master.csv, which nothing reads now.
            # Verified 2026-09-14 that the Dhan path has never served a quote
            # (DHAN_ACCESS_TOKEN unset; all quote_cache rows are source=yahoo).
        })

    eq_count  = sum(1 for o in out if o["kind"] == "EQUITY")
    etf_count = len(out) - eq_count

    if eq_count < 1800:
        raise RuntimeError(f"sanity_fail: only {eq_count} equities (expected >=1800)")

    existing = _supa_get_active_symbols()
    fresh    = {row["symbol"] for row in out}
    to_deactivate = existing - fresh

    upserted    = _supa_upsert_chunked(out, chunk=500)
    deactivated = _supa_deactivate(to_deactivate)

    return {
        "ok": True,
        "equityCount":  eq_count,
        "etfCount":     etf_count,
        "upserted":     upserted,
        "deactivated":  deactivated,
        "durationMs":   int((time.time() - t0) * 1000),
    }

# ── HTTP handler ────────────────────────────────────────────────────────────
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
        if not (SUPA_URL and SUPA_SRV):
            return self._reply(500, {"ok": False, "error": "supabase_not_configured"})
        if not _auth_ok(self.headers.get("Authorization")):
            return self._reply(401, {"ok": False, "error": "unauthorized"})
        try:
            return self._reply(200, _run_sync())
        except urllib.error.HTTPError as e:
            try: detail = e.read().decode("utf-8")[:300]
            except Exception: detail = str(e)
            return self._reply(502, {"ok": False, "error": f"http_{e.code}", "detail": detail})
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
