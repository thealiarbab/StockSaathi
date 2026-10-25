"""GET /api/weekly-report  —  Sunday "your week" email, one per active user.

Migration 2026-10-24c: weekly_report_due() lists users active in the last 30
days who left recap emails on, with this week's portfolio value against last
week's (daily_snapshot rows), trades this week, and their best and worst
holding over the week on official NSE closes. After a batch is accepted by
Resend, mark_weekly_report_sent() logs each user for this week (so a rerun
skips them) and leaves the same summary in the bell, which push carries to
devices that take recaps.

Tracking (migration 2026-10-24e): before sending, log_weekly_skips() logs the
holdout and opted-out users who would have qualified; each sent email gets an
email_log row (Resend id, delivery checked hourly) and an outbound_log row;
links carry ss_e=<email id> for click counting; a refused batch is logged as
send_failed.

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
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler

import _email_layout as L

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
PAGE = 1000               # PostgREST's max rows per response
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


def _link(path, eid=None):
    return f"{SITE}{path}{'&' if '?' in path else '?'}{UTM}" + (f"&ss_e={eid}" if eid else "")


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


def render(u, eid=None):
    ch, p, title, _ = summary(u)
    name = html.escape(first_name(u.get("display_name")))
    colour = "#00B386" if ch >= 0 else "#E5484D"
    t = int(u.get("trades") or 0)
    rows = [("Portfolio now", inr(u["value_now"])), ("A week ago", inr(u["value_then"])),
            ("Trades this week", str(t) if t else "None")]
    subject = f"Your week on StockSaathi: {inr(ch, True)} ({pct(p)})" if ch else "Your week on StockSaathi"
    fig = html.escape(inr(ch, True))
    fig = f'{fig} <span style="font-size:16px; color:#D4F7EA;">({html.escape(pct(p))})</span>'
    pairs = [(k, html.escape(v)) for k, v in rows]
    if u.get("best_symbol") is not None:
        pairs += [(html.escape(l.split(": ", 1)[0].upper()), html.escape(l.split(": ", 1)[1]))
                  for l in mover_lines(u, "|", False).split("|")]
    blocks = [
        L.heading("Your week on StockSaathi",
                  f"Hi {name}, here's how your virtual portfolio did over the last 7 days."),
        L.ticket("WEEKLY REPORT", "READY", [(k.upper(), v) for k, v in pairs]),
        L.button("Open your report card", _link("/report-card", eid)),
        L.note("<strong>A week says little on its own.</strong> Your report card shows the habits behind the number."),
        L.small(f'Virtual money only: nothing real was bought or sold. <a href="{SETTINGS}" style="color:#00875A;">Turn off weekly emails</a>.'),
    ]
    body = L.page(subject, "How your virtual portfolio did this week, and your report card.",
                  ("THIS WEEK", fig, "VIRTUAL · 0 REAL RISK"), blocks,
                  "You're receiving this because you have a StockSaathi portfolio.")
    text = "\n".join([f"Hi {first_name(u.get('display_name'))}, here's your week.", "",
                      f"{inr(ch, True)} ({pct(p)})", f"Portfolio now: {inr(u['value_now'])}",
                      f"A week ago: {inr(u['value_then'])}", f"Trades this week: {t or 'None'}"]
                     + ([mover_lines(u, chr(10), False)] if u.get("best_symbol") is not None else [])
                     + ["", f"Your report card: {_link('/report-card', eid)}", "", f"Turn off weekly emails: {SETTINGS}"])
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
    skipped = _rpc("log_weekly_skips", {})
    tried = set()
    while due:
        sent, errors = _send_round(due, week, sent, errors)
        tried.update(u["user_id"] for u in due)
        # The database API returns at most 1,000 rows per call, so on 25 Oct
        # exactly 1,000 went out and the rest were never asked for. Sent users
        # drop out of weekly_report_due, so ask again until a short page;
        # users from a failed batch are not retried in the same run.
        if len(due) < PAGE or len(tried) >= MAX_USERS:
            break
        due = [u for u in (_rpc("weekly_report_due", {"p_limit": MAX_USERS}) or [])
               if u["user_id"] not in tried][:MAX_USERS - len(tried)]
    return {"ok": not errors, "sent_users": sent, "due_users": len(tried), "skips_logged": skipped, "errors": errors}, None


def _send_round(due, week, sent, errors):
    for i in range(0, len(due), BATCH):
        chunk = due[i:i + BATCH]
        items, marks = [], []
        for u in chunk:
            eid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"weekly:{week}:{u['user_id']}"))
            subject, body, text = render(u, eid)
            _, _, title, bell = summary(u)
            items.append({"from": FROM, "to": [u["email"]], "reply_to": REPLY_TO, "subject": subject,
                          "html": body, "text": text,
                          "headers": {"List-Unsubscribe": f"<mailto:{REPLY_TO}?subject=unsubscribe>, <{SETTINGS}>"}})
            marks.append({"user_id": u["user_id"], "email_id": eid, "subject": subject, "title": title, "body": bell})
        key = f"weekly-{week}-" + hashlib.sha256(",".join(sorted(m["user_id"] for m in marks)).encode()).hexdigest()[:32]
        try:
            res = _resend_batch(items, key)
        except Exception as e:
            errors.append(str(e)[:200])
            try:
                _rpc("log_send_failed", {"p_kind": "weekly_report",
                                         "p_rows": [{"user_id": m["user_id"], "error": str(e)[:300]} for m in marks]})
            except Exception:
                pass
            continue
        # Resend answers the batch in order: {"data": [{"id": ...}, ...]}.
        rids = [d.get("id") for d in (res.get("data") or [])] if isinstance(res, dict) else []
        for m, rid in zip(marks, rids + [None] * len(marks)):
            m["resend_id"] = rid
        _rpc("mark_weekly_report_sent", {"p_rows": marks})
        sent += len(chunk)
    return sent, errors


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
