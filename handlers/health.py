"""GET /api/health  —  Vercel serverless function."""

import os
import json
from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Don't enumerate which provider is configured — that's recon for
        # attackers. Just answer the two questions the client actually needs:
        # can we send email? can we call the LLM?
        any_email = bool(
            (os.environ.get("SMTP_USER") and os.environ.get("SMTP_PASS"))
            or os.environ.get("RESEND_API_KEY")
        )
        any_llm = bool(os.environ.get("GROQ_API_KEY"))
        any_db = bool(os.environ.get("SUPABASE_URL")
                      and os.environ.get("SUPABASE_ANON_KEY"))
        body = json.dumps({
            "ok": True,
            "runtime": os.environ.get("RUNTIME", "vercel"),
            "email_configured": any_email,
            "llm_configured": any_llm,
            "db_configured": any_db,
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()
