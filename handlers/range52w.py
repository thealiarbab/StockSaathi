"""GET /api/range52w — every stock's real 52-week high/low in one cached reply.

WHY THIS EXISTS

The Markets tiles (js/data/range52w.js) used to read fundamentals_cache from
the browser, one batch of visible symbols at a time. Every batch was a new URL
on another origin, so each one also cost a CORS preflight. Measured 16 Oct
2026: 7,110 reads + 6,678 preflights a day against Supabase, while the org was
over its egress quota, for numbers that change once a night.

This endpoint is same-origin (no preflight) and CDN-cached for hours, so
Supabase is asked a handful of times a day instead of ~14k. The whole map is
~5k symbols, about 45 KB compressed, and the browser keeps it for 12 hours.

Reply: {"ok": true, "n": <count>, "r": {"SYMBOL": [high_rupees, low_rupees]}}
Only rows with high > low > 0 are included; a missing symbol has no real range.
"""

import json
import math
import os
from http.server import BaseHTTPRequestHandler

import _supa_http

PAGE = 1000   # PostgREST's max rows per request on Supabase


def _key():
    return (os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
            or os.environ.get("SUPABASE_ANON_KEY", "").strip())


def load_ranges():
    key = _key()
    if not key:
        raise RuntimeError("no supabase key")
    headers = {"apikey": key, "Authorization": "Bearer " + key}
    out, offset = {}, 0
    while True:
        status, body = _supa_http.request(
            "GET",
            "/rest/v1/fundamentals_cache?select=symbol,fifty_two_week_high,fifty_two_week_low"
            "&fifty_two_week_high=gt.0&fifty_two_week_low=gt.0"
            f"&order=symbol&limit={PAGE}&offset={offset}",
            headers=headers, timeout=6)
        if status != 200:
            raise RuntimeError(f"fundamentals_cache {status}")
        rows = json.loads(body)
        for r in rows:
            try:
                hi, lo = float(r["fifty_two_week_high"]), float(r["fifty_two_week_low"])
            except (TypeError, ValueError, KeyError):
                continue
            if math.isfinite(hi) and math.isfinite(lo) and hi > lo > 0 and r.get("symbol"):
                out[r["symbol"]] = [round(hi, 2), round(lo, 2)]
        if len(rows) < PAGE:
            return out
        offset += PAGE


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            ranges = load_ranges()
        except Exception as e:
            print(f"[range52w] load failed: {e}")
            self._json(502, {"ok": False, "error": "load_failed"}, cache=False)
            return
        self._json(200, {"ok": True, "n": len(ranges), "r": ranges}, cache=True)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def _json(self, code, obj, cache):
        body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if cache:
            # Ranges are refreshed nightly. Browser 1 h, CDN 6 h, and the CDN
            # may serve a day-old copy while it refetches in the background.
            self.send_header("Cache-Control",
                             "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400")
        else:
            self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
