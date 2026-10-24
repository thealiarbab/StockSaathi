"""GET/POST /api/email-status  —  what happened to the emails we sent.

pg_cron `email-status` calls this at :15 every hour (migration 2026-10-24e).
email_status_due() lists email_log rows from the last 7 days that are not yet
final (bounced / complained / clicked), oldest check first; each is looked up
in Resend (GET /emails/{id}, which answers with `last_event`: sent,
delivered, opened, clicked, bounced, complained, delivery_delayed) and
set_email_status() stores it. An email is rechecked every 6 hours until it is
final or a week old, so opens that come days later are still counted.

Open tracking only works where Resend has it on for the sending domain (on for
news.stocksaathi.co.in, off for stocksaathi.co.in); clicks are also counted by
the site itself (ss_e in every link -> log_email_click).

Resend allows 10 requests a second: one lookup every 0.12 s, at most 250 a
run, inside the 60 s function limit.

Auth: Authorization: Bearer <CRON_SECRET> (or ADMIN_TOKEN). Stdlib only.
"""

import json
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler

SUPA_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_SRV = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()
CRON_SECRET = os.environ.get("CRON_SECRET", "").strip()
RESEND_KEY = os.environ.get("RESEND_API_KEY", "").strip()

PER_RUN = 250
GAP_S = 0.12
DEADLINE_S = 50


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


def _rpc(name, args, timeout=20):
    req = urllib.request.Request(
        f"{SUPA_URL}/rest/v1/rpc/{name}", data=json.dumps(args).encode("utf-8"), method="POST",
        headers={"apikey": SUPA_SRV, "Authorization": f"Bearer {SUPA_SRV}",
                 "Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode("utf-8")
        return json.loads(body) if body else None


def _resend_get(rid):
    req = urllib.request.Request(f"https://api.resend.com/emails/{rid}", method="GET",
                                 headers={"Authorization": f"Bearer {RESEND_KEY}",
                                          "User-Agent": "stocksaathi-email-status/1"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


def run():
    t0 = time.monotonic()
    due = _rpc("email_status_due", {"p_limit": PER_RUN}) or []
    rows, failed, counts = [], 0, {}
    for e in due:
        if time.monotonic() - t0 > DEADLINE_S:
            break
        try:
            ev = (_resend_get(e["resend_id"]).get("last_event") or "").strip()
        except urllib.error.HTTPError as err:
            if err.code == 429:          # rate limited: stop, the next run picks up
                break
            failed += 1
            ev = ""
        except Exception:
            failed += 1
            ev = ""
        # A failed lookup still stamps checked_at, so one bad id can't block the queue.
        rows.append({"id": e["id"], "last_event": ev})
        if ev:
            counts[ev] = counts.get(ev, 0) + 1
        time.sleep(GAP_S)
    stored = _rpc("set_email_status", {"p_rows": rows}) if rows else 0
    return {"ok": True, "due": len(due), "checked": len(rows), "stored": stored,
            "lookup_failed": failed, "events": counts}


class handler(BaseHTTPRequestHandler):
    def _answer(self, code, payload):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if not _auth_ok(self.headers.get("Authorization")):
            return self._answer(401, {"ok": False, "error": "unauthorized"})
        if not (SUPA_URL and SUPA_SRV and RESEND_KEY):
            return self._answer(500, {"ok": False, "error": "not configured"})
        try:
            return self._answer(200, run())
        except Exception as e:
            return self._answer(502, {"ok": False, "error": str(e)[:300]})

    do_POST = do_GET
