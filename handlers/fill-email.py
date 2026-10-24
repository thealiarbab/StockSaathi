"""GET /api/fill-email  —  "your order filled" by email, for users push can't reach.

Migration 2026-10-24b: fill_email_due() lists users with an unread order_filled
notice from the last 24 h that was not emailed and that push did not deliver
(no live push subscription for orders), who left order emails on. One email
per user lists all of their fills; mark_fill_emailed() then stamps the rows so
the next run skips them.

SENDING IS OFF unless BOTH hold:
  * env FILL_EMAIL_ON = "1" (Vercel), and
  * the call says ?send=1 (the cron path does; a manual check does not).
Otherwise it is a dry run that answers how many users and fills are due.

?preview=1 returns the rendered email for the first due user, sends nothing.

Auth: Authorization: Bearer <CRON_SECRET> (or ADMIN_TOKEN). Stdlib only.
Resend batch API: up to 100 emails per call, so ~500 users fit in one run
well inside the 60 s function limit.
"""

import hashlib
import html
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler

SUPA_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_SRV = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()
CRON_SECRET = os.environ.get("CRON_SECRET", "").strip()
RESEND_KEY = os.environ.get("RESEND_API_KEY", "").strip()
SEND_ON = os.environ.get("FILL_EMAIL_ON", "").strip() == "1"

FROM = os.environ.get("FILL_EMAIL_FROM", "").strip() or "StockSaathi <orders@stocksaathi.co.in>"
REPLY_TO = "business@stocksaathi.co.in"
SITE = "https://stocksaathi.co.in"
SETTINGS = f"{SITE}/settings#notifications"
UTM = "utm_source=email&utm_medium=transactional&utm_campaign=order_filled"
MAX_USERS = 500
BATCH = 100
IST = timezone(timedelta(hours=5, minutes=30))
FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif"


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


def first_name(display):
    """First word of the display name when it looks like a name, else 'there'."""
    w = (display or "").strip().split()
    w = w[0] if w else ""
    if "@" in w or not w.isalpha() or not 2 <= len(w) <= 15:
        return "there"
    return w[0].upper() + w[1:].lower() if w.isascii() else w


def _link(path):
    path = path if path and path.startswith("/") else "/portfolio"
    return f"{SITE}{path}{'&' if '?' in path else '?'}{UTM}"


def _when(iso):
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(IST)
        return f"{t.day} {t:%b}, {t.hour % 12 or 12}:{t:%M} {'AM' if t.hour < 12 else 'PM'}"
    except Exception:
        return ""


def subject_for(fills):
    if len(fills) == 1:
        return fills[0].get("title") or "Your order filled"
    return f"{len(fills)} of your orders filled"


def render(user, fills):
    """(subject, html, text) for one user's fills. Titles and bodies come from
    the database (e.g. 'Buy 10 RELIANCE filled', 'At ₹2,847.35.'), escaped."""
    name = html.escape(first_name(user.get("display_name")))
    subject = subject_for(fills)
    head = "Your order filled" if len(fills) == 1 else f"{len(fills)} of your orders filled"
    rows = "".join(f"""
          <tr><td style="padding:12px 0;border-top:1px solid #E6E8EC;">
            <a href="{html.escape(_link(f.get('url')))}" style="font:700 15px/1.4 {FONT};color:#0A0A0A;text-decoration:none;">{html.escape(f.get('title') or 'Order filled')}</a>
            <div style="font:400 14px/1.5 {FONT};color:#30343B;">{html.escape(f.get('body') or '')} <span style="color:#6B7280;">{html.escape(_when(f.get('at') or ''))}</span></div>
          </td></tr>""" for f in fills)
    body = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>{html.escape(subject)}</title>
<style>
  :root {{ color-scheme: light dark; supported-color-schemes: light dark; }}
  @media (prefers-color-scheme: dark) {{
    body, [style*="background:#F1F3F6"] {{ background: #0A0B0F !important; }}
    [style*="background:#FFFFFF"] {{ background: #13161E !important; }}
    [style*="color:#0A0A0A"] {{ color: #F1F3F7 !important; }}
    [style*="color:#30343B"] {{ color: #C9CED8 !important; }}
    [style*="color:#6B7280"] {{ color: #8F97A8 !important; }}
    [style*="border-top:1px solid #E6E8EC"] {{ border-color: #262A36 !important; }}
  }}
</style></head>
<body style="margin:0;padding:0;background:#F1F3F6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">See how it's doing since it filled.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F3F6;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:12px;">
      <tr><td style="padding:24px 28px 0 28px;font:700 16px/1 {FONT};color:#0A0A0A;">StockSaathi</td></tr>
      <tr><td style="padding:16px 28px 0 28px;font:700 22px/1.3 {FONT};color:#0A0A0A;">{html.escape(head)}</td></tr>
      <tr><td style="padding:8px 28px 4px 28px;font:400 15px/1.6 {FONT};color:#30343B;">Hi {name}, here's what happened with your virtual orders.</td></tr>
      <tr><td style="padding:0 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">{rows}
      </table></td></tr>
      <tr><td style="padding:20px 28px 0 28px;">
        <a href="{html.escape(_link('/portfolio'))}" style="display:inline-block;background:#00B386;color:#FFFFFF;font:700 15px/1 {FONT};padding:13px 20px;border-radius:8px;text-decoration:none;">See your portfolio</a>
      </td></tr>
      <tr><td style="padding:20px 28px 26px 28px;font:400 13px/1.6 {FONT};color:#6B7280;">
        Want these as phone alerts instead? Tap the bell at the top of StockSaathi and turn them on.<br>
        You get this because an order you placed on StockSaathi filled. It's virtual money: nothing real was bought or sold.
        <a href="{SETTINGS}" style="color:#6B7280;">Turn off order emails</a>.
      </td></tr>
    </table>
  </td></tr>
</table></body></html>"""
    text = "\n".join(
        [f"Hi {first_name(user.get('display_name'))},", "", head + ":", ""]
        + [f"- {f.get('title') or 'Order filled'} {f.get('body') or ''} ({_when(f.get('at') or '')})" for f in fills]
        + ["", f"See your portfolio: {_link('/portfolio')}", "",
           f"Turn off order emails: {SETTINGS}"])
    return subject, body, text


def _resend_batch(items, key):
    req = urllib.request.Request(
        "https://api.resend.com/emails/batch", data=json.dumps(items).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {RESEND_KEY}", "Content-Type": "application/json",
                 "Idempotency-Key": key, "User-Agent": "stocksaathi-fill-email/1"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


def run(send=False, preview=False, hours=24):
    due = _rpc("fill_email_due", {"p_hours": hours}) or []
    due = due[:MAX_USERS]
    fills = sum(len(u.get("fills") or []) for u in due)
    if preview:
        if not due:
            return {"ok": True, "due_users": 0}, None
        return None, render(due[0], due[0]["fills"])[1]
    if not send:
        return {"ok": True, "dry_run": True, "send_on": SEND_ON, "due_users": len(due), "due_fills": fills}, None
    if not SEND_ON or not RESEND_KEY:
        return {"ok": False, "error": "sending is off (FILL_EMAIL_ON / RESEND_API_KEY)", "due_users": len(due)}, None

    sent_users = sent_fills = 0
    errors = []
    for i in range(0, len(due), BATCH):
        chunk = due[i:i + BATCH]
        items = []
        ids = []
        for u in chunk:
            subject, body, text = render(u, u["fills"])
            items.append({"from": FROM, "to": [u["email"]], "reply_to": REPLY_TO, "subject": subject,
                          "html": body, "text": text,
                          "headers": {"List-Unsubscribe": f"<mailto:{REPLY_TO}?subject=unsubscribe>, <{SETTINGS}>"}})
            ids.extend(f["id"] for f in u["fills"])
        key = "fill-" + hashlib.sha256(",".join(sorted(ids)).encode()).hexdigest()[:40]
        try:
            _resend_batch(items, key)
        except Exception as e:
            errors.append(str(e)[:200])
            continue
        _rpc("mark_fill_emailed", {"p_ids": ids})
        sent_users += len(chunk)
        sent_fills += len(ids)
    return {"ok": not errors, "sent_users": sent_users, "sent_fills": sent_fills, "errors": errors}, None


class handler(BaseHTTPRequestHandler):
    def _answer(self, code, payload=None, html_body=None):
        raw = (html_body if html_body is not None else json.dumps(payload)).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8" if html_body is not None else "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if not _auth_ok(self.headers.get("Authorization")):
            return self._answer(401, {"ok": False, "error": "unauthorized"})
        if not (SUPA_URL and SUPA_SRV):
            return self._answer(500, {"ok": False, "error": "supabase not configured"})
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        try:
            hours = int((q.get("hours") or ["24"])[0])
        except ValueError:
            hours = 24
        try:
            payload, page = run(send=(q.get("send") or [""])[0] == "1",
                                preview=(q.get("preview") or [""])[0] == "1", hours=hours)
        except Exception as e:
            return self._answer(502, {"ok": False, "error": str(e)[:300]})
        if page is not None:
            return self._answer(200, html_body=page)
        return self._answer(200, payload)

    do_POST = do_GET
