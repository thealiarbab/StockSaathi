"""GET /api/quote?symbol=RELIANCE  —  single-symbol live quote.

Normalized JSON output so the client doesn't need to parse Yahoo's nested
structure. Tries query1 then query2 with a realistic User-Agent.
"""

import re
import json
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote as url_quote


UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
      "AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/125.0.0.0 Safari/537.36")

HOSTS = [
    "https://query1.finance.yahoo.com/v8/finance/chart",
    "https://query2.finance.yahoo.com/v8/finance/chart",
]

_SYMBOL_RE = re.compile(r"^[A-Z0-9.\-\^=_&]{1,24}$")


def fetch_one(symbol):
    """Fetch a single symbol from Yahoo. Returns dict or None."""
    # Match the other API files: only skip the .NS suffix when the symbol
    # already has an exchange dot-suffix (e.g. TATAMOTORS.BO). Hyphenated
    # NSE tickers like BAJAJ-AUTO still need .NS appended.
    # The universe ships 1,145 BSE rows and 542 NSE_SME rows alongside
    # 2,680 NSE ones, but this only ever asked Yahoo for ".NS", so every
    # BSE-only listing resolved to nothing. Try NSE first (unchanged for
    # the common case), then fall back to ".BO". Costs one extra request
    # only for symbols that were previously returning no price at all.
    tickers = [symbol] if "." in symbol else [f"{symbol}.NS", f"{symbol}.BO"]
    for ticker, base in ((t, b) for t in tickers for b in HOSTS):
        try:
            url = f"{base}/{url_quote(ticker, safe='.')}?interval=1d&range=5d"
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "application/json,text/plain,*/*",
                "Accept-Language": "en-US,en;q=0.9",
            })
            with urllib.request.urlopen(req, timeout=8) as r:
                raw = r.read()
            data = json.loads(raw)
            result = (data.get("chart") or {}).get("result") or [{}]
            if not result:
                continue
            meta = result[0].get("meta") or {}
            price = meta.get("regularMarketPrice")
            if price is None:
                continue
            # Yahoo strips "premium" meta fields (regularMarketPreviousClose,
            # previousClose) when rate-limiting our IPs — only chartPreviousClose
            # survives, and that's the close from 5d ago for range=5d. Grab
            # yesterday's close from the chart's closes[] array instead: the
            # last non-null entry before closes[-1] (today) is yesterday.
            closes_arr = ((result[0].get("indicators", {}).get("quote") or [{}])[0]
                          .get("close") or [])
            prev_from_chart = None
            # Walk back from second-to-last — closes[-1] is today's running bar
            for i in range(len(closes_arr) - 2, -1, -1):
                c = closes_arr[i]
                if c is not None:
                    prev_from_chart = c
                    break
            prev = (meta.get("regularMarketPreviousClose")
                    or meta.get("previousClose")
                    or prev_from_chart
                    or meta.get("chartPreviousClose")
                    or price)
            return {
                "symbol": symbol,
                "ticker": ticker,
                "price": float(price),
                "prev_close": float(prev),
                "change_pct": ((float(price) - float(prev)) / float(prev)) if prev else 0.0,
                "day_high": float(meta.get("regularMarketDayHigh") or price),
                "day_low": float(meta.get("regularMarketDayLow") or price),
                "volume": int(meta.get("regularMarketVolume") or 0),
                "ts_ms": int((meta.get("regularMarketTime") or 0)) * 1000,
                "currency": meta.get("currency") or "INR",
                "exchange": meta.get("exchangeName") or "",
                "source": "yahoo",
                "host": base.split("//")[1].split("/")[0],
            }
        except Exception:
            continue
    return {"error": "yahoo_unreachable"}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        symbol = (q.get("symbol") or [""])[0].strip().upper()
        # nocache=1 is the refresh-button path — the frontend has explicitly
        # asked for an uncached tick. Signal downstream (Vercel edge, the
        # browser, any HTTP-aware proxy) to hand back a no-store response
        # rather than a recent cached one.
        nocache = (q.get("nocache") or ["0"])[0] == "1"
        if not symbol or not _SYMBOL_RE.match(symbol):
            self._json(400, {"ok": False, "error": "bad_symbol"}, nocache=nocache)
            return
        # MFs have no Yahoo coverage. Reject early so we don't burn 5-7 sec
        # hitting query1.finance.yahoo.com only to 404. Front-end uses
        # synthMFQuote() (NAV-based) for MF symbols and never sends them
        # here in practice — this guard catches accidental cross-calls.
        if symbol.startswith("MF_"):
            self._json(400, {"ok": False, "error": "mf_no_yahoo_quote",
                             "detail": "MF NAV is in inst.nav (AMFI catalog), not /api/quote"},
                       nocache=nocache)
            return
        data = fetch_one(symbol)
        if data.get("error"):
            self._json(502, {"ok": False, **data}, nocache=nocache)
            return
        self._json(200, {"ok": True, **data}, nocache=nocache)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def _json(self, code, obj, nocache=False):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # Refresh-button path: tell every upstream cache "do NOT store this".
        # Normal path: 8-second edge cache — matches the client-side TTL and
        # absorbs burst traffic without going stale.
        if nocache:
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
