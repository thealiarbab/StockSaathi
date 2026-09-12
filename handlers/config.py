"""GET /api/config  —  exposes public client-side config.
Supabase URL + anon key are SAFE to expose (Row Level Security enforces access).
"""

import os
import json
from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({
            "supabaseUrl": os.environ.get("SUPABASE_URL", "").strip(),
            "supabaseAnonKey": os.environ.get("SUPABASE_ANON_KEY", "").strip(),
            "appName": "StockSaathi",
            "supportEmail": os.environ.get("SUPPORT_EMAIL", "accounts@stocksaathi.co.in"),
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=30")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()
