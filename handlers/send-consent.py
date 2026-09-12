"""POST /api/send-consent — Vercel serverless parent-consent email endpoint.

Replaces the missing Vercel handler (onboarding was silently 404ing before).
Hardened against: email header injection, consent-URL phishing, CORS/CSRF
abuse, oversized payloads, and key leakage via exception strings.
"""

import os
import json
import time
import threading
from http.server import BaseHTTPRequestHandler
from collections import defaultdict, deque

try:
    from api._email import (
        consent_body, send_email, sanitize_header, is_valid_email,
        is_safe_consent_url, resolve_consent_allowlist, redact,
    )
except ImportError:
    # Vercel sometimes runs api/*.py with cwd = api/
    from _email import (  # type: ignore
        consent_body, send_email, sanitize_header, is_valid_email,
        is_safe_consent_url, resolve_consent_allowlist, redact,
    )


RATE_LIMIT_PER_HOUR = int(os.environ.get("CONSENT_RATE_PER_HOUR", "20"))
MAX_BODY = 8 * 1024  # 8 KB — request is tiny (to/teen/token/url)
_rate_lock = threading.Lock()
_rate_bucket = defaultdict(deque)

PUBLIC_ORIGIN = os.environ.get("PUBLIC_ORIGIN", "").rstrip("/")
_ALLOWED_ORIGINS = {
    PUBLIC_ORIGIN,
    "https://stocksaathi.co.in",
    "https://www.stocksaathi.co.in",
    "http://localhost:7348",
    "http://127.0.0.1:7348",
}
_ALLOWED_ORIGINS.discard("")


def _allow_origin(origin):
    if not origin:
        return None
    if origin in _ALLOWED_ORIGINS:
        return origin
    # Allow Vercel preview deployments (https://<branch>-<hash>.vercel.app)
    if origin.startswith("https://") and origin.endswith(".vercel.app"):
        return origin
    return None


class handler(BaseHTTPRequestHandler):
    def _json(self, code, obj, origin_hdr=None):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        allow = _allow_origin(origin_hdr)
        if allow:
            self.send_header("Access-Control-Allow-Origin", allow)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        origin = self.headers.get("Origin")
        self.send_response(204)
        allow = _allow_origin(origin)
        if allow:
            self.send_header("Access-Control-Allow-Origin", allow)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,X-StockSaathi-Relay")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_POST(self):
        origin = self.headers.get("Origin")
        # CSRF defence: only accept requests whose Origin is in our allowlist.
        # (Curl/native clients can skip Origin; we still require rate limits.)
        if origin and not _allow_origin(origin):
            self._json(403, {"ok": False, "error": "forbidden_origin"}, origin)
            return

        # Body-size cap
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except Exception:
            length = 0
        if length > MAX_BODY:
            self._json(413, {"ok": False, "error": "payload_too_large"}, origin)
            return

        # Rate limit by IP. X-Forwarded-For from Vercel edge is trustworthy;
        # we take the first hop only (leftmost = original client).
        ip = (self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
              or self.headers.get("X-Real-IP", "").strip()
              or "unknown")
        now = time.time()
        with _rate_lock:
            bucket = _rate_bucket[ip]
            while bucket and now - bucket[0] > 3600:
                bucket.popleft()
            if len(bucket) >= RATE_LIMIT_PER_HOUR:
                self._json(429, {"ok": False, "error": "rate_limited",
                                 "detail": f"Max {RATE_LIMIT_PER_HOUR} consent emails/hour."}, origin)
                return
            bucket.append(now)

        try:
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._json(400, {"ok": False, "error": "bad_json"}, origin)
            return

        to = (data.get("to") or data.get("parentEmail") or "").strip()
        teen = sanitize_header(data.get("teenName") or "your child")
        token = sanitize_header(str(data.get("token") or ""))
        consent_url = (data.get("consentUrl") or "").strip()[:512]
        relay = self.headers.get("X-StockSaathi-Relay", "") == "1"

        if not is_valid_email(to):
            self._json(400, {"ok": False, "error": "bad_recipient"}, origin)
            return
        allowlist = resolve_consent_allowlist()
        if consent_url and not is_safe_consent_url(consent_url, allowlist):
            self._json(400, {"ok": False, "error": "bad_consent_url",
                             "detail": "consentUrl host is not on the allowlist."}, origin)
            return

        subject = sanitize_header(f"StockSaathi - Consent requested for {teen}")
        body = consent_body(teen, to, token, consent_url)
        try:
            result = send_email(
                to_email=to, subject=subject, body=body,
                token=token, teen=teen, consent_url=consent_url,
                relay_header=relay, log_dir="/tmp/stocksaathi_email_logs",
            )
        except Exception as e:
            self._json(500, {"ok": False, "error": "send_failed",
                             "detail": redact(str(e))[:120]}, origin)
            return
        self._json(200 if result.get("ok") else 500, result, origin)
