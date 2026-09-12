"""Shared email helpers for the consent flow.

Importable from both backend.py (single-process server) and api/send-consent.py
(Vercel serverless). Keeps the delivery + body-templating logic in one place
so the two entry-points cannot drift.

Exports:
  consent_body(teen, to_email, token, consent_url)   -> plain-text email body
  send_email(to, subject, body, token, teen, consent_url, relay_header)
      -> {ok, provider, ...}
  sanitize_header(value)                             -> strip CR/LF
  is_valid_email(addr)                               -> bool
  is_safe_consent_url(url, allowlist)                -> bool
  redact(err_str)                                    -> mask bearer tokens in error text
"""

import os
import re
import json
import ssl
import smtplib
import urllib.request
import urllib.error
from datetime import datetime
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formatdate

_BEARER_RE = re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]+", re.IGNORECASE)
_KEY_RE = re.compile(r"((?:re_|gsk_|sk-ant-|sk-)[A-Za-z0-9._\-]{8,})")
_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")
_HEADER_STRIP = re.compile(r"[\r\n\x00]+")


def redact(text):
    if not text:
        return text
    s = str(text)
    s = _BEARER_RE.sub(r"\1<redacted>", s)
    s = _KEY_RE.sub("<redacted>", s)
    return s


def sanitize_header(value):
    """Strip CR/LF/NUL from a value that will end up in an email header.
    Prevents SMTP header injection via teenName/subject fields."""
    if not value:
        return ""
    return _HEADER_STRIP.sub(" ", str(value)).strip()[:120]


def is_valid_email(addr):
    if not addr or len(addr) > 254:
        return False
    return bool(_EMAIL_RE.match(addr.strip()))


def is_safe_consent_url(url, allowlist):
    """Only accept https URLs whose host is in the allowlist.
    `allowlist` is a list of hostnames (e.g. ['stocksaathi.co.in', 'localhost']).
    Returns False for any other origin, preventing open-redirect phishing.
    """
    if not url:
        return True  # empty is fine — UI will fall back to in-app token
    try:
        from urllib.parse import urlparse
        u = urlparse(url)
    except Exception:
        return False
    if u.scheme not in ("https", "http"):
        return False
    host = (u.hostname or "").lower()
    if not host:
        return False
    if u.scheme == "http" and host not in ("localhost", "127.0.0.1"):
        return False
    for allowed in allowlist:
        a = allowed.lower()
        if host == a or host.endswith("." + a):
            return True
    return False


def consent_body(teen, to_email, token, consent_url):
    """Plain-text body for the parent consent email.
    Never embed user HTML — stick to plaintext so email clients can't render
    attacker markup. The token is echoed so parents can type it manually if
    the consent link is blocked by their mail provider."""
    teen_s = sanitize_header(teen) or "your child"
    token_s = sanitize_header(token) or "(no token)"
    url_line = f"\n  {consent_url}\n" if consent_url else ""
    return (
        f"Hi there,\n\n"
        f"{teen_s} wants to start learning about investing with StockSaathi — "
        f"a simulator that uses virtual money and real stock prices to teach "
        f"behavioural finance.\n\n"
        f"There are no real trades, no real money, and no advice. The app is "
        f"free and stops whenever you want it to.\n\n"
        f"To approve, either click the link below or share this consent code "
        f"with {teen_s} in the app:\n"
        f"{url_line}\n"
        f"  Consent code: {token_s}\n\n"
        f"If you did not expect this email, you can ignore it and no account "
        f"will be created.\n\n"
        f"— StockSaathi\n"
        f"  accounts@stocksaathi.co.in\n"
    )


# --------------------------------------------------------------------------
# Providers
# --------------------------------------------------------------------------

def _send_via_smtp(to_email, subject, body):
    host = os.environ.get("SMTP_HOST")
    port = int(os.environ.get("SMTP_PORT", 587))
    user = os.environ.get("SMTP_USER")
    pw = os.environ.get("SMTP_PASS")
    sender = os.environ.get("SMTP_FROM") or user
    if not (host and user and pw):
        return {"ok": False, "reason": "smtp_not_configured"}

    msg = MIMEMultipart("alternative")
    msg["From"] = sanitize_header(sender)
    msg["To"] = sanitize_header(to_email)
    msg["Subject"] = sanitize_header(subject)
    msg["Date"] = formatdate(localtime=True)
    msg.attach(MIMEText(body, "plain", "utf-8"))

    try:
        if port == 465:
            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, context=ctx, timeout=15) as s:
                s.login(user, pw)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=15) as s:
                s.ehlo()
                s.starttls()
                s.ehlo()
                s.login(user, pw)
                s.send_message(msg)
        return {"ok": True, "provider": "smtp", "host": host}
    except Exception as e:
        return {"ok": False, "reason": "smtp_error", "error": redact(str(e))[:200]}


def _send_via_resend(to_email, subject, body):
    key = os.environ.get("RESEND_API_KEY")
    sender = os.environ.get("RESEND_FROM", "onboarding@resend.dev")
    if not key:
        return {"ok": False, "reason": "resend_not_configured"}
    payload = json.dumps({
        "from": sender,
        "to": to_email,
        "subject": sanitize_header(subject),
        "text": body,
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=payload,
        headers={
            "Authorization": f"Bearer {key.strip()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "StockSaathi/1.0 (+https://stocksaathi.local)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode("utf-8"))
            return {"ok": True, "provider": "resend", "id": data.get("id")}
    except urllib.error.HTTPError as e:
        try:
            raw = e.read().decode("utf-8")
            err = json.loads(raw)
        except Exception:
            err = {"message": "upstream_error"}
        return {"ok": False, "reason": "resend_http_error", "status": e.code, "error": err}
    except Exception as e:
        return {"ok": False, "reason": "resend_exception", "error": redact(str(e))[:200]}


def _log_to_devfile(to_email, subject, body, log_dir):
    from pathlib import Path
    try:
        log_dir = Path(log_dir)
        log_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe = "".join(c if c.isalnum() else "_" for c in to_email)[:40]
        path = log_dir / f"{ts}_{safe}.txt"
        path.write_text(
            f"TO: {to_email}\nSUBJECT: {subject}\nSENT-AT: {datetime.now().isoformat()}\n\n{body}\n",
            encoding="utf-8",
        )
        # Rotation: keep newest 200 files only (bounded disk usage).
        try:
            files = sorted(log_dir.glob("*.txt"), key=lambda p: p.stat().st_mtime, reverse=True)
            for old in files[200:]:
                try: old.unlink()
                except Exception: pass
        except Exception:
            pass
        return str(path)
    except Exception:
        return None


def send_email(to_email, subject, body, token=None, teen=None,
               consent_url=None, relay_header=False, log_dir=None):
    """Try SMTP → Resend → devlog. Returns the first success, otherwise a
    dev-mode OK response that echoes the token to the client so onboarding
    can continue even with zero email config."""
    attempts = []
    if os.environ.get("SMTP_USER") and os.environ.get("SMTP_PASS"):
        r = _send_via_smtp(to_email, subject, body)
        if r.get("ok"):
            return r
        attempts.append({"provider": "smtp", **r})
    if os.environ.get("RESEND_API_KEY"):
        r = _send_via_resend(to_email, subject, body)
        if r.get("ok"):
            return r
        attempts.append({"provider": "resend", **r})
    if log_dir:
        _log_to_devfile(to_email, subject, body, log_dir)
    return {
        "ok": True,
        "provider": "devlog",
        "attempts": attempts,
        "dev_token": token,
        "warning": ("All delivery attempts failed — falling back to dev mode. "
                    "Your consent code is shown inline so you can still use the app."),
    }


def resolve_consent_allowlist():
    """Hosts allowed in the consent_url. Always includes stocksaathi.co.in
    and localhost; extra hosts can come from CONSENT_URL_ALLOWLIST
    (comma-separated). Vercel preview URLs are accepted via the
    `vercel.app` suffix."""
    base = ["stocksaathi.co.in", "localhost", "127.0.0.1", "vercel.app"]
    extra = os.environ.get("CONSENT_URL_ALLOWLIST", "")
    for h in extra.split(","):
        h = h.strip()
        if h:
            base.append(h)
    return base
