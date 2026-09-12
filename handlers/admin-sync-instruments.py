"""GET/POST /api/admin-sync-instruments — daily NSE universe sync.

Ports scripts/build-universe.mjs to Python and upserts the NSE equity + ETF
universe into Supabase public.dhan_instruments via service-role. Soft-deletes
any symbol present in DB but absent from a fresh fetch (sets is_active=false
rather than deleting, so historical holdings keep their references).

Auth (either accepted):
  Authorization: Bearer <ADMIN_TOKEN>     # manual trigger via /api/ai
  Authorization: Bearer <CRON_SECRET>     # Vercel cron auto-injects

Stdlib-only — no requirements.txt entry needed (Vercel @vercel/python ships
urllib/csv/json/concurrent.futures + ssl by default).
"""

import csv
import gzip
import io
import json
import os
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler

# ── env ─────────────────────────────────────────────────────────────────────
SUPA_URL    = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_SRV    = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()
CRON_SECRET = os.environ.get("CRON_SECRET", "").strip()

# ── browser-like session (NSE/niftyindices 403 anything else) ───────────────
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
BROWSER_HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
}

def _build_opener():
    jar = CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(jar),
        urllib.request.HTTPRedirectHandler(),
    )
    opener.addheaders = list(BROWSER_HEADERS.items())
    return opener, jar

def _fetch(opener, url, referer=None, accept=None, timeout=12):
    req = urllib.request.Request(url)
    if referer:
        req.add_header("Referer", referer)
    if accept:
        req.add_header("Accept", accept)
    with opener.open(req, timeout=timeout) as r:
        data = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            data = gzip.decompress(data)
        return data

def _warm(opener, host):
    try:
        _fetch(opener, f"https://{host}/", timeout=8)
    except Exception:
        pass

# ── CSV helpers ─────────────────────────────────────────────────────────────
def _parse_csv(blob_bytes):
    text = blob_bytes.decode("utf-8-sig", errors="replace")
    return list(csv.DictReader(io.StringIO(text)))

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
def _map_sector(ind, symbol="", name=""):
    if not ind:
        return "Other"
    base = NSE_TO_SS.get(_stripq(ind), "Other")
    # Refine "Financial Services" macro: split Banks / Insurance / Exchange / Fintech / NBFC.
    if base == "NBFC" and (ind == "Financial Services"):
        u = symbol.upper()
        n = name.upper()
        if "BANK" in u or "BANK" in n: return "Banking"
        if "INSURANCE" in n or "LIFE" in n: return "Insurance"
        if u in ("BSE", "MCX", "IEX", "NSDL", "CDSL"): return "Exchange"
        if u in ("PAYTM", "POLICYBZR") or "FINTECH" in n: return "Fintech"
    return base

# ── idx bitmask + classifiers ───────────────────────────────────────────────
IDX_N50, IDX_N100, IDX_N500 = 1<<0, 1<<1, 1<<2
IDX_MID150, IDX_SMALL250    = 1<<3, 1<<4

def _cap_bucket(idx):
    if idx & IDX_N50:       return "mega"
    if idx & IDX_N100:      return "large"
    if idx & IDX_N500:      return "mid"
    if idx & IDX_MID150:    return "mid"
    if idx & IDX_SMALL250:  return "small"
    return "micro"

def _risk(idx, series):
    if idx & IDX_N50:   return "low"
    if idx & IDX_N100:  return "low"
    if idx & IDX_N500:  return "med"
    if idx & IDX_MID150:return "med"
    if series in ("BE","BZ"): return "high"
    return "high"

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
NIFTY_FILES = {
    "n50":      "ind_nifty50list.csv",
    "n100":     "ind_nifty100list.csv",
    "n500":     "ind_nifty500list.csv",
    "mid150":   "ind_niftymidcap150list.csv",
    "small250": "ind_niftysmallcap250list.csv",
    "tm":       "ind_niftytotalmarket_list.csv",
}

def _fetch_nifty(opener, file):
    url = f"https://niftyindices.com/IndexConstituent/{file}"
    rows = _parse_csv(_fetch(opener, url, referer="https://niftyindices.com/indices/equity"))
    syms = set()
    for r in rows:
        sym = _stripq(r.get("Symbol") or r.get("symbol") or r.get("SYMBOL"))
        if sym: syms.add(sym)
    return syms, rows

def _run_sync():
    t0 = time.time()
    opener, _jar = _build_opener()
    _warm(opener, "www.nseindia.com")

    eq_blob = _fetch(
        opener,
        "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv",
        referer="https://www.nseindia.com/market-data/securities-available-for-trading",
    )
    equities = _parse_csv(eq_blob)

    _warm(opener, "niftyindices.com")
    constituents = {}
    industry_by_sym = {}
    def _try(key):
        try: return key, _fetch_nifty(opener, NIFTY_FILES[key])
        except Exception: return key, (set(), [])
    with ThreadPoolExecutor(max_workers=6) as ex:
        for key, (syms, rows) in ex.map(_try, NIFTY_FILES.keys()):
            constituents[key] = syms
            if key == "tm":
                for r in rows:
                    sym = _stripq(r.get("Symbol"))
                    ind = _stripq(r.get("Industry") or r.get("Macro-Economic Sector"))
                    if sym and ind: industry_by_sym[sym] = ind

    etfs = []
    try:
        etf_blob = _fetch(
            opener,
            "https://www.nseindia.com/api/etf",
            referer="https://www.nseindia.com/market-data/exchange-traded-funds-etf",
            accept="application/json,text/plain,*/*",
        )
        etfs = (json.loads(etf_blob).get("data") or [])
    except Exception:
        pass

    out = []
    seen = set()
    for r in equities:
        sym = _stripq(r.get("SYMBOL"))
        ser = _stripq(r.get("SERIES"))
        if not sym or ser not in ("EQ","BE","BZ") or sym in seen:
            continue
        idx = 0
        if sym in constituents.get("n50",      ()): idx |= IDX_N50
        if sym in constituents.get("n100",     ()): idx |= IDX_N100
        if sym in constituents.get("n500",     ()): idx |= IDX_N500
        if sym in constituents.get("mid150",   ()): idx |= IDX_MID150
        if sym in constituents.get("small250", ()): idx |= IDX_SMALL250
        try: lot = int(_stripq(r.get("MARKET LOT") or r.get(" MARKET LOT") or "1"))
        except ValueError: lot = 1
        name = _stripq(r.get("NAME OF COMPANY") or r.get("NAME OF COMPANY "))
        out.append({
            "symbol": sym,
            "name":   name,
            "series": ser,
            "isin":   _stripq(r.get("ISIN NUMBER") or r.get(" ISIN NUMBER")),
            "idx_tags": idx,
            "sector": _map_sector(industry_by_sym.get(sym, ""), sym, name),
            "cap_bucket": _cap_bucket(idx),
            "risk_tier":  _risk(idx, ser),
            "lot_size": lot,
            "kind":   "EQUITY",
            "is_active": True,
        })
        seen.add(sym)

    eq_count = len(out)
    for e in etfs:
        sym = _stripq(e.get("symbol"))
        if not sym or sym in seen: continue
        meta = e.get("meta") or {}
        out.append({
            "symbol": sym,
            "name":   _stripq(meta.get("companyName") or e.get("assets") or sym),
            "series": "EQ",
            "isin":   _stripq(meta.get("isin") or e.get("isin")),
            "idx_tags": 0,
            "sector": "ETF",
            "cap_bucket": "unknown",
            "risk_tier":  "med",
            "lot_size": 1,
            "kind":   "ETF",
            "is_active": True,
        })
        seen.add(sym)
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
