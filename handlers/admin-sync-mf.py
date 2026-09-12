"""GET/POST /api/admin-sync-mf — daily AMFI mutual-fund refresh.

Fetches https://portal.amfiindia.com/spages/NAVAll.txt (~17,000 raw scheme
rows / ~14,000 parseable schemes), parses the proprietary semicolon-delimited
format, and bulk-upserts every active scheme into the `mf_master` Supabase
table. Idempotent — re-running on the same day is a no-op.

Auth: Authorization: Bearer <ADMIN_TOKEN>  (manual trigger)
   OR Authorization: Bearer <CRON_SECRET>  (Vercel cron auto-injects)

Vercel maxDuration is 60s. AMFI's text file is ~3 MB; fetch + parse + bulk
upsert finishes in 10-20s for the full catalog. Bulk-upsert is chunked at
500 rows per request to stay under PostgREST's URL/body limits.

Mirrors scripts/build-mf-universe.mjs's parser logic. Front-end mfFull.json
is generated locally + committed; this Python parser is the *server-side*
source of truth used by Ask Saathi search and future SIP analytics.
"""

import json
import os
import re
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler

AMFI_URL = "https://portal.amfiindia.com/spages/NAVAll.txt"
UA = "Mozilla/5.0 (compatible; StockSaathi-MF-Sync/1.0)"

SUPA_URL    = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_SRV    = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()
CRON_SECRET = os.environ.get("CRON_SECRET", "").strip()

UPSERT_CHUNK = 500


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


# ── AMFI parsing helpers — keep in sync with scripts/build-mf-universe.mjs ─

_DATA_LINE_RE = re.compile(r"^\d{4,7};")
_CAT_HEADER_RE = re.compile(r"^(Open|Close|Interval) Ended Schemes\((.+)\)\s*$")
_AMC_HEADER_RE = re.compile(r"mutual fund$|amc$", re.IGNORECASE)


def bucket_for(category):
    c = (category or "").lower()
    if re.search(r"gold|silver", c):
        return "Commodity"
    if re.search(r"fund of fund|overseas|international|fof", c):
        return "FoF"
    if re.search(r"index fund|etf|exchange traded", c):
        return "Index"
    if re.search(r"^equity scheme|equity fund", c):
        return "Equity"
    if re.search(r"^debt scheme|debt fund|liquid fund|gilt|bond fund|duration fund|money market|overnight", c):
        return "Debt"
    if re.search(r"^hybrid scheme|hybrid fund|balanced|arbitrage|equity savings|conservative hybrid|aggressive hybrid|multi asset|dynamic asset", c):
        return "Hybrid"
    if re.search(r"solution|retirement|children", c):
        return "Solution"
    if c == "income":
        return "Debt"
    if c == "growth":
        return "Equity"
    if c == "elss":
        return "Equity"
    return "Other"


def risk_for(category, bucket):
    c = (category or "").lower()
    if re.search(r"sectoral|thematic|small cap|micro cap", c):
        return "high"
    if bucket == "Equity":
        if re.search(r"large cap|focused|elss|dividend yield|value", c):
            return "med"
        return "high"
    if bucket == "Index":
        return "med"
    if bucket == "Hybrid":
        if re.search(r"aggressive hybrid|equity savings|multi asset", c):
            return "med"
        if re.search(r"conservative|arbitrage", c):
            return "low"
        return "med"
    if bucket == "Debt":
        if re.search(r"credit risk|long duration", c) and not re.search(r"10 year", c):
            return "med"
        return "low"
    return "med"


def bench_for(category, bucket):
    c = (category or "").lower()
    if re.search(r"large cap fund", c):           return "NIFTY 100"
    if re.search(r"mid cap fund", c):             return "NIFTY Midcap 150"
    if re.search(r"small cap fund", c):           return "NIFTY Smallcap 250"
    if re.search(r"large & mid|large and mid", c):return "NIFTY LargeMidcap 250"
    if re.search(r"multi cap|flexi cap", c):      return "NIFTY 500"
    if re.search(r"elss", c):                     return "NIFTY 500"
    if re.search(r"focused fund|value fund|contra", c): return "NIFTY 500"
    if re.search(r"dividend yield", c):           return "NIFTY Dividend Opportunities 50"
    if re.search(r"index fund|etf", c):           return "Linked Index"
    if re.search(r"sectoral|thematic", c):        return "Sectoral Index"
    if re.search(r"aggressive hybrid", c):        return "CRISIL Hybrid 35+65"
    if re.search(r"conservative hybrid|equity savings", c): return "CRISIL Hybrid 75+25"
    if re.search(r"balanced advantage|dynamic asset", c):   return "CRISIL Hybrid 50+50"
    if re.search(r"arbitrage", c):                return "NIFTY 50 Arbitrage"
    if re.search(r"multi asset", c):              return "Multi-Asset Index"
    if re.search(r"liquid fund", c):              return "CRISIL Liquid Fund Index"
    if re.search(r"overnight", c):                return "CRISIL Overnight Index"
    if re.search(r"gilt fund", c):                return "CRISIL Gilt Index"
    if re.search(r"credit risk", c):              return "CRISIL Credit Risk Index"
    if re.search(r"corporate bond", c):           return "CRISIL Corporate Bond Index"
    if re.search(r"banking and psu|banking & psu", c): return "CRISIL Banking & PSU Index"
    if re.search(r"short duration|low duration|ultra short|money market", c): return "CRISIL Short-Term Index"
    if re.search(r"medium duration|medium to long|long duration|dynamic bond", c): return "CRISIL Medium-Long Index"
    if re.search(r"floater", c):                  return "CRISIL Floater Index"
    if re.search(r"gold", c):                     return "Domestic Gold"
    if re.search(r"silver", c):                   return "Domestic Silver"
    if re.search(r"retirement|children", c):      return "Lifecycle Index"
    if re.search(r"overseas|international|nasdaq|s&p 500|us tech", c): return "International Index"
    if re.search(r"fund of fund|fof", c):         return "Underlying Fund"
    return "AMFI Category Index"


def parse_plan_option(name):
    n = (name or "").lower()
    plan = "Direct" if re.search(r"\bdirect\b", n) else "Regular"
    if re.search(r"\bidcw\b|\bdividend\b|payout|reinvest", n):
        option = "IDCW"
    elif re.search(r"bonus", n):
        option = "Bonus"
    else:
        option = "Growth"
    return plan, option


_MONTHS = {"Jan": "01", "Feb": "02", "Mar": "03", "Apr": "04", "May": "05", "Jun": "06",
           "Jul": "07", "Aug": "08", "Sep": "09", "Oct": "10", "Nov": "11", "Dec": "12"}


def parse_amfi_date(s):
    m = re.match(r"^(\d{1,2})-([A-Za-z]{3})-(\d{4})$", (s or "").strip())
    if not m:
        return None
    mm = _MONTHS.get(m.group(2))
    if not mm:
        return None
    return f"{m.group(3)}-{mm}-{m.group(1).zfill(2)}"


def tidy_amc(amc):
    if not amc:
        return ""
    amc = re.sub(r"Asset Management Company Limited", "", amc, flags=re.IGNORECASE)
    amc = re.sub(r"Asset Management", "", amc, flags=re.IGNORECASE)
    amc = re.sub(r"AMC Limited", "", amc, flags=re.IGNORECASE)
    amc = re.sub(r"Company Limited", "", amc, flags=re.IGNORECASE)
    amc = re.sub(r"\s+-\s+", " ", amc)
    amc = re.sub(r"\s{2,}", " ", amc).strip()
    return amc


def parse_amfi(text):
    """Parse NAVAll.txt → list[dict] of mf_master row payloads."""
    rows = []
    seen = set()
    cur_cat = ""
    cur_kind = "Open"
    cur_amc = ""
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        m = _CAT_HEADER_RE.match(line)
        if m:
            cur_kind = m.group(1)
            cur_cat = m.group(2).strip()
            continue
        if line.startswith("Scheme Code;"):
            continue
        if _DATA_LINE_RE.match(line):
            cols = [c.strip() for c in line.split(";")]
            if len(cols) < 6:
                continue
            amfi_code, isin1, isin2, name, nav_str, date_str = cols[:6]
            if not amfi_code or not name or amfi_code in seen:
                continue
            seen.add(amfi_code)
            try:
                nav = float(nav_str)
                if nav <= 0:
                    continue
            except (ValueError, TypeError):
                continue
            plan, option = parse_plan_option(name)
            bucket = bucket_for(cur_cat or "Other")
            rows.append({
                "symbol": f"MF_{amfi_code}",
                "amfi_code": amfi_code,
                "name": name,
                "amc": tidy_amc(cur_amc) or "Unknown AMC",
                "category": cur_cat or "Other",
                "category_bucket": bucket,
                "plan_type": plan,
                "option_type": option,
                "scheme_kind": cur_kind,
                "isin_growth": isin1 if isin1 and isin1 != "-" else None,
                "isin_idcw":   isin2 if isin2 and isin2 != "-" else None,
                "nav": nav,
                "nav_date": parse_amfi_date(date_str),
                "risk": risk_for(cur_cat or "", bucket),
                "bench": bench_for(cur_cat or "", bucket),
                "is_active": True,
                "cached_at_ms": int(time.time() * 1000),
            })
            continue
        if re.match(r"^;+\s*$", line):
            continue
        if len(line) >= 3 and _AMC_HEADER_RE.search(line):
            cur_amc = line
    return rows


def fetch_amfi():
    req = urllib.request.Request(AMFI_URL, headers={"User-Agent": UA, "Accept": "text/plain, */*"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", errors="replace")


def chunk_upsert(rows):
    """Bulk-upsert rows to mf_master, chunked. Returns total rows written."""
    if not (SUPA_URL and SUPA_SRV) or not rows:
        return 0
    url = f"{SUPA_URL}/rest/v1/mf_master"
    headers = _supa_headers({"Prefer": "resolution=merge-duplicates,return=minimal"})
    written = 0
    for i in range(0, len(rows), UPSERT_CHUNK):
        chunk = rows[i:i + UPSERT_CHUNK]
        body = json.dumps(chunk).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                r.read()
            written += len(chunk)
        except Exception:
            # Continue with the next chunk — losing one chunk is better than
            # rolling back a partial upsert. The next cron pass will retry
            # the missed rows automatically (idempotent merge-duplicates).
            pass
    return written


def deactivate_missing(active_codes):
    """Mark schemes that disappeared from AMFI (merger, liquidation) inactive.
    Pure UPDATE — preserves history. Skip if active list is suspiciously small
    (parser regression — would otherwise nuke the catalog)."""
    if not (SUPA_URL and SUPA_SRV) or len(active_codes) < 1000:
        return 0
    # PostgREST: not.in.(comma-list) — chunk to avoid URL bloat.
    # Easier path: fetch the full active set, diff, then PATCH the diff.
    try:
        url = f"{SUPA_URL}/rest/v1/mf_master?select=amfi_code&is_active=eq.true&limit=20000"
        req = urllib.request.Request(url, headers=_supa_headers({"Accept": "application/json"}))
        with urllib.request.urlopen(req, timeout=15) as r:
            existing = {row["amfi_code"] for row in json.loads(r.read())}
    except Exception:
        return 0
    missing = list(existing - set(active_codes))
    if not missing:
        return 0
    # PATCH in chunks of 200 codes via in.(...).
    deactivated = 0
    for i in range(0, len(missing), 200):
        chunk = missing[i:i + 200]
        in_clause = ",".join(f'"{c}"' for c in chunk)
        url = f"{SUPA_URL}/rest/v1/mf_master?amfi_code=in.({in_clause})"
        body = json.dumps({"is_active": False}).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=_supa_headers({"Prefer": "return=minimal"}), method="PATCH")
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                r.read()
            deactivated += len(chunk)
        except Exception:
            pass
    return deactivated


def _run_sync():
    if not (SUPA_URL and SUPA_SRV):
        return {"ok": False, "error": "supabase_not_configured"}

    t0 = time.time()
    try:
        text = fetch_amfi()
    except Exception as e:
        return {"ok": False, "error": "amfi_fetch_failed", "detail": str(e)[:200]}

    rows = parse_amfi(text)
    if len(rows) < 1000:
        return {"ok": False, "error": "amfi_parse_underfilled", "rows": len(rows)}

    written = chunk_upsert(rows)
    deactivated = deactivate_missing([r["amfi_code"] for r in rows])

    # Bucket distribution for cron-log diagnostics.
    by_bucket = {}
    for r in rows:
        b = r["category_bucket"]
        by_bucket[b] = by_bucket.get(b, 0) + 1

    return {
        "ok": True,
        "raw_lines": text.count("\n") + 1,
        "parsed_rows": len(rows),
        "upserted": written,
        "deactivated": deactivated,
        "by_bucket": by_bucket,
        "duration_ms": int((time.time() - t0) * 1000),
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
            return self._reply(200, _run_sync())
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
