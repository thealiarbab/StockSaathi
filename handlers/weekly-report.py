"""GET /api/weekly-report  —  Sunday "your week" email, one per active user.

Migration 2026-10-24c: weekly_report_due() lists users active in the last 30
days who left recap emails on, with this week's portfolio value against last
week's (daily_snapshot rows), trades this week, and their best and worst
holding over the week on official NSE closes. After a batch is accepted by
Resend, mark_weekly_report_sent() logs each user for this week (so a rerun
skips them) and leaves the same summary in the bell, which push carries to
devices that take recaps.

SENDING IS OFF unless BOTH hold:
  * env WEEKLY_EMAIL_ON = "1" (Vercel), and
  * the call says ?send=1 (the cron path does; a manual check does not).
Otherwise it is a dry run that answers how many users are due.

?preview=1 returns the rendered email for the first due user, sends nothing.

Auth: Authorization: Bearer <CRON_SECRET> (or ADMIN_TOKEN). Stdlib only.
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
SEND_ON = os.environ.get("WEEKLY_EMAIL_ON", "").strip() == "1"

FROM = os.environ.get("WEEKLY_EMAIL_FROM", "").strip() or "StockSaathi <hello@news.stocksaathi.co.in>"
REPLY_TO = "business@stocksaathi.co.in"
SITE = "https://stocksaathi.co.in"
SETTINGS = f"{SITE}/settings#notifications"
UTM = "utm_source=email&utm_medium=recap&utm_campaign=weekly_report"
MAX_USERS = 2500          # 25 batches of 100: well inside the 60 s limit
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


def _rpc(name, args, timeout=30):
    req = urllib.request.Request(
        f"{SUPA_URL}/rest/v1/rpc/{name}", data=json.dumps(args).encode("utf-8"), method="POST",
        headers={"apikey": SUPA_SRV, "Authorization": f"Bearer {SUPA_SRV}",
                 "Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode("utf-8")
        return json.loads(body) if body else None


def inr(paise, signed=False):
    """₹1,23,456.78 (Indian grouping, always two decimals)."""
    p = int(paise or 0)
    neg = p < 0
    rupees, ps = divmod(abs(p), 100)
    s = str(rupees)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        s = ",".join(parts + [tail])
    out = f"₹{s}.{ps:02d}"
    if signed:
        return ("−" if neg else "+") + out
    return ("−" if neg else "") + out


def pct(x, signed=True):
    x = float(x or 0)
    return (("−" if x < 0 else "+") if signed else ("−" if x < 0 else "")) + f"{abs(x):.2f}%"


def first_name(display):
    w = (display or "").strip().split()
    w = w[0] if w else ""
    if "@" in w or not w.isalpha() or not 2 <= len(w) <= 15:
        return "there"
    return w[0].upper() + w[1:].lower() if w.isascii() else w


def _link(path):
    return f"{SITE}{path}{'&' if '?' in path else '?'}{UTM}"


def summary(u):
    """(change_paise, change_pct, title, bell_body) for one user."""
    now, then = int(u["value_now"]), int(u["value_then"])
    ch = now - then
    p = 100.0 * ch / then if then else 0.0
    title = "Your week: flat" if ch == 0 else f"Your week: {inr(ch, True)} ({pct(p)})"
    t = int(u.get("trades") or 0)
    bits = [f"{t} trade{'s' if t != 1 else ''}" if t else "No trades"]
    if u.get("best_symbol") is not None and u.get("best_pct") is not None:
        bits.append(f"{'Best' if float(u['best_pct']) >= 0 else 'Held up best'}: {u['best_symbol']} {pct(u['best_pct'])}")
    bits.append("Your report card is ready.")
    return ch, p, title, ". ".join(bits[:-1]) + ". " + bits[-1]


def mover_lines(u, sep, as_html):
    """Best and worst holding over the week; one line when there is only one."""
    e = html.escape if as_html else (lambda x: x)
    sym = (lambda x: f"<b>{e(x)}</b>") if as_html else e
    best, worst = u["best_symbol"], u["worst_symbol"]
    if best == worst:
        return f"Your stock: {sym(best)} {e(pct(u['best_pct']))}"
    label = "Best" if float(u["best_pct"]) >= 0 else "Held up best"
    return sep.join([f"{label}: {sym(best)} {e(pct(u['best_pct']))}",
                     f"{'Worst' if float(u['worst_pct']) < 0 else 'Smallest gain'}: {sym(worst)} {e(pct(u['worst_pct']))}"])


def render(u):
    ch, p, title, _ = summary(u)
    name = html.escape(first_name(u.get("display_name")))
    colour = "#00B386" if ch >= 0 else "#E5484D"
    t = int(u.get("trades") or 0)
    rows = [("Portfolio now", inr(u["value_now"])), ("A week ago", inr(u["value_then"])),
            ("Trades this week", str(t) if t else "None")]
    movers = ""
    if u.get("best_symbol") is not None:
        movers = f"""
      <tr><td style="padding:18px 28px 0 28px;font:700 15px/1.3 {FONT};color:#0A0A0A;">Your stocks this week</td></tr>
      <tr><td style="padding:6px 28px 0 28px;font:400 15px/1.7 {FONT};color:#30343B;">
        {mover_lines(u, "<br>", True)}
      </td></tr>"""
    table = "".join(f"""
          <tr><td style="padding:10px 0;border-top:1px solid #E6E8EC;font:400 15px/1.4 {FONT};color:#30343B;">{k}</td>
              <td align="right" style="padding:10px 0;border-top:1px solid #E6E8EC;font:700 15px/1.4 {FONT};color:#0A0A0A;">{html.escape(v)}</td></tr>"""
                    for k, v in rows)
    subject = f"Your week on StockSaathi: {inr(ch, True)} ({pct(p)})" if ch else "Your week on StockSaathi"
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
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">How your virtual portfolio did this week, and your report card.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F3F6;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:12px;">
      <tr><td style="padding:24px 28px 0 28px;font:700 16px/1 {FONT};color:#0A0A0A;">StockSaathi</td></tr>
      <tr><td style="padding:16px 28px 0 28px;font:400 15px/1.5 {FONT};color:#30343B;">Hi {name}, here's your week.</td></tr>
      <tr><td style="padding:6px 28px 0 28px;font:700 30px/1.2 {FONT};color:{colour};">{html.escape(inr(ch, True))} <span style="font-size:18px;">({html.escape(pct(p))})</span></td></tr>
      <tr><td style="padding:14px 28px 0 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">{table}
      </table></td></tr>{movers}
      <tr><td style="padding:22px 28px 0 28px;">
        <a href="{html.escape(_link('/report-card'))}" style="display:inline-block;background:#00B386;color:#FFFFFF;font:700 15px/1 {FONT};padding:13px 20px;border-radius:8px;text-decoration:none;">Open your report card</a>
      </td></tr>
      <tr><td style="padding:20px 28px 26px 28px;font:400 13px/1.6 {FONT};color:#6B7280;">
        Virtual money only: nothing real was bought or sold. A week up or down says little on its own; your report card shows the habits behind it.<br>
        <a href="{SETTINGS}" style="color:#6B7280;">Turn off weekly emails</a>.
      </td></tr>
    </table>
  </td></tr>
</table></body></html>"""
    text = "\n".join([f"Hi {first_name(u.get('display_name'))}, here's your week.", "",
                      f"{inr(ch, True)} ({pct(p)})", f"Portfolio now: {inr(u['value_now'])}",
                      f"A week ago: {inr(u['value_then'])}", f"Trades this week: {t or 'None'}"]
                     + ([mover_lines(u, chr(10), False)] if u.get("best_symbol") is not None else [])
                     + ["", f"Your report card: {_link('/report-card')}", "", f"Turn off weekly emails: {SETTINGS}"])
    return subject, body, text


def _resend_batch(items, key):
    req = urllib.request.Request(
        "https://api.resend.com/emails/batch", data=json.dumps(items).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {RESEND_KEY}", "Content-Type": "application/json",
                 "Idempotency-Key": key, "User-Agent": "stocksaathi-weekly-report/1"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


def run(send=False, preview=False):
    due = (_rpc("weekly_report_due", {"p_limit": MAX_USERS}) or [])[:MAX_USERS]
    if preview:
        return ({"ok": True, "due_users": 0}, None) if not due else (None, render(due[0])[1])
    if not send:
        return {"ok": True, "dry_run": True, "send_on": SEND_ON, "due_users": len(due)}, None
    if not SEND_ON or not RESEND_KEY:
        return {"ok": False, "error": "sending is off (WEEKLY_EMAIL_ON / RESEND_API_KEY)", "due_users": len(due)}, None

    week = datetime.now(IST).date().isoformat()
    sent = 0
    errors = []
    for i in range(0, len(due), BATCH):
        chunk = due[i:i + BATCH]
        items, marks = [], []
        for u in chunk:
            subject, body, text = render(u)
            _, _, title, bell = summary(u)
            items.append({"from": FROM, "to": [u["email"]], "reply_to": REPLY_TO, "subject": subject,
                          "html": body, "text": text,
                          "headers": {"List-Unsubscribe": f"<mailto:{REPLY_TO}?subject=unsubscribe>, <{SETTINGS}>"}})
            marks.append({"user_id": u["user_id"], "title": title, "body": bell})
        key = f"weekly-{week}-" + hashlib.sha256(",".join(sorted(m["user_id"] for m in marks)).encode()).hexdigest()[:32]
        try:
            _resend_batch(items, key)
        except Exception as e:
            errors.append(str(e)[:200])
            continue
        _rpc("mark_weekly_report_sent", {"p_rows": marks})
        sent += len(chunk)
    return {"ok": not errors, "sent_users": sent, "due_users": len(due), "errors": errors}, None


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
            payload, page = run(send=(q.get("send") or [""])[0] == "1",
                                preview=(q.get("preview") or [""])[0] == "1")
        except Exception as e:
            return self._answer(502, {"ok": False, "error": str(e)[:300]})
        if page is not None:
            return self._answer(200, html_body=page)
        return self._answer(200, payload)

    do_POST = do_GET
