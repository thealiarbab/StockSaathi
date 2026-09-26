"""POST /api/admin-ingest-eod — store NSE's end-of-day bhavcopy, apply it.

A second, official price source behind Yahoo. See
supabase/migrations/2026-09-27c_nse_eod_second_price_source.sql for why.

NSE blocks Vercel, so this handler never fetches from NSE. The GitHub runner
in .github/workflows/nse-eod.yml downloads the bhavcopy (NSE does not block
runners) and posts the parsed rows here:

  {"trade_date": "2026-09-25",
   "rows": [["RELIANCE", "EQ", open, high, low, close, prev_close, volume], ...]}

Prices are rupees as NSE publishes them; stored as paise. Then
public.apply_nse_eod(trade_date) adds missing quote_cache rows, replaces
prices from before that trading day, and returns every stock where a same-day
Yahoo price disagrees with the exchange close by more than 15%.

Auth: Authorization: Bearer <CRON_SECRET> (or ADMIN_TOKEN). Stdlib only.
"""

import json
import os
import re
import urllib.request
from http.server import BaseHTTPRequestHandler

SUPA_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_SRV = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()
CRON_SECRET = os.environ.get("CRON_SECRET", "").strip()

CHUNK = 1000
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_SYM_RE = re.compile(r"^[A-Z0-9&\-_.]{1,24}$")


def _auth_ok(header):
    if not header or not header.startswith("Bearer "):
        return False
    tok = header[7:].strip()
    ok = False
    for secret in (ADMIN_TOKEN, CRON_SECRET):
        if secret and tok and len(tok) == len(secret):
            diff = 0
            for a, b in zip(tok, secret):
                diff |= ord(a) ^ ord(b)
            if diff == 0:
                ok = True
    return ok


def _paise(v):
    try:
        f = float(v)
        return int(round(f * 100)) if f > 0 else None
    except (TypeError, ValueError):
        return None


def _post(path, payload, prefer=None, timeout=20):
    headers = {"apikey": SUPA_SRV, "Authorization": f"Bearer {SUPA_SRV}",
               "Content-Type": "application/json", "Accept": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
    req = urllib.request.Request(f"{SUPA_URL}/rest/v1/{path}", data=json.dumps(payload).encode("utf-8"),
                                 headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode("utf-8")
        return json.loads(body) if body else None


def ingest(trade_date, rows):
    records = []
    for r in rows:
        if not isinstance(r, (list, tuple)) or len(r) < 8:
            continue
        sym, series = str(r[0]).strip().upper(), str(r[1]).strip().upper()
        close = _paise(r[5])
        if not _SYM_RE.match(sym) or close is None:
            continue
        try:
            vol = int(float(r[7] or 0))
        except (TypeError, ValueError):
            vol = 0
        records.append({"symbol": sym, "trade_date": trade_date, "series": series,
                        "open_paise": _paise(r[2]), "high_paise": _paise(r[3]), "low_paise": _paise(r[4]),
                        "close_paise": close, "prev_close_paise": _paise(r[6]), "volume": vol})
    # One row per symbol per day. NSE lists a few symbols under two series;
    # keep the tradeable equity series when that happens.
    rank = {"EQ": 0, "BE": 1, "BZ": 2, "SM": 3, "ST": 4}
    best = {}
    for rec in records:
        cur = best.get(rec["symbol"])
        if cur is None or rank.get(rec["series"], 9) < rank.get(cur["series"], 9):
            best[rec["symbol"]] = rec
    records = list(best.values())
    for i in range(0, len(records), CHUNK):
        _post("nse_eod_prices?on_conflict=symbol,trade_date", records[i:i + CHUNK],
              prefer="resolution=merge-duplicates,return=minimal")
    applied = _post("rpc/apply_nse_eod", {"p_trade_date": trade_date}, timeout=40)
    return {"ok": True, "stored": len(records), **(applied or {})}


class handler(BaseHTTPRequestHandler):
    def _respond(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not _auth_ok(self.headers.get("Authorization")):
            return self._respond(401, {"ok": False, "error": "unauthorized"})
        if not (SUPA_URL and SUPA_SRV):
            return self._respond(500, {"ok": False, "error": "supabase_not_configured"})
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
            data = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except Exception:
            return self._respond(400, {"ok": False, "error": "bad_json"})
        trade_date = str(data.get("trade_date") or "")
        rows = data.get("rows")
        if not _DATE_RE.match(trade_date) or not isinstance(rows, list) or not rows:
            return self._respond(400, {"ok": False, "error": "need trade_date YYYY-MM-DD and rows"})
        try:
            self._respond(200, ingest(trade_date, rows))
        except Exception as e:
            self._respond(500, {"ok": False, "error": str(e)[:300]})
