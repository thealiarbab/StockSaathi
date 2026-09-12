"""GET /api/  —  tiny root ping. Also satisfies Vercel's entrypoint check."""

import json
from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({
            "ok": True,
            "name": "StockSaathi API",
            "endpoints": [
                "/api/health",
                "/api/config",
                "/api/quote?symbol=X",
                "/api/quotes?symbols=A,B,C",
                "/api/fundamentals?symbol=X",
                "/api/yahoo/chart/X",
                "/api/chat (POST)",
            ],
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()
