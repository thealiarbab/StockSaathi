"""GET /api/quotes?symbols=RELIANCE,TCS,INFY  —  batch quotes, parallel.

Fetches up to 60 symbols from Yahoo Finance concurrently (20 worker
threads). Returns a dict keyed by original symbol. Symbols without a
dot get '.NS' appended automatically.
"""

import re
import json
import urllib.request
import urllib.error
import concurrent.futures
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote as url_quote


UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
      "AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/125.0.0.0 Safari/537.36")

HOSTS = [
    "https://query1.finance.yahoo.com/v8/finance/chart",
    "https://query2.finance.yahoo.com/v8/finance/chart",
]

MAX_SYMBOLS = 60
WORKERS = 40   # higher concurrency — one thread per symbol so tail latency = slowest single call

_SYMBOL_RE = re.compile(r"^[A-Z0-9.\-\^=_&]{1,24}$")


def fetch_one(symbol):
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
            with urllib.request.urlopen(req, timeout=3.5) as r:
                data = json.loads(r.read())
            result = (data.get("chart") or {}).get("result") or [{}]
            if not result:
                continue
            meta = result[0].get("meta") or {}
            price = meta.get("regularMarketPrice")
            if price is None:
                continue
            # Yahoo strips regularMarketPreviousClose + previousClose when
            # rate-limiting. Parse closes[] to pull yesterday from the chart
            # array directly — second-to-last non-null entry (closes[-1] is
            # today's in-progress bar). See quote.py for the full rationale.
            closes_arr = ((result[0].get("indicators", {}).get("quote") or [{}])[0]
                          .get("close") or [])
            prev_from_chart = None
            for i in range(len(closes_arr) - 2, -1, -1):
                if closes_arr[i] is not None:
                    prev_from_chart = closes_arr[i]
                    break
            prev = (meta.get("regularMarketPreviousClose")
                    or meta.get("previousClose")
                    or prev_from_chart
                    or meta.get("chartPreviousClose")
                    or price)
            return {
                "symbol": symbol, "ticker": ticker,
                "price": float(price),
                "prev_close": float(prev),
                "change_pct": ((float(price) - float(prev)) / float(prev)) if prev else 0.0,
                "day_high": float(meta.get("regularMarketDayHigh") or price),
                "day_low": float(meta.get("regularMarketDayLow") or price),
                "volume": int(meta.get("regularMarketVolume") or 0),
                "ts_ms": int((meta.get("regularMarketTime") or 0)) * 1000,
                "currency": meta.get("currency") or "INR",
                "source": "yahoo",
            }
        except Exception:
            continue
    return None


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        raw = (q.get("symbols") or [""])[0]
        raw_syms = [s.strip().upper() for s in raw.split(",") if s.strip()][:MAX_SYMBOLS]
        # Silently drop malformed symbols — one bad apple shouldn't 400 the whole batch.
        syms = [s for s in raw_syms if _SYMBOL_RE.match(s)]
        if not syms:
            self._json(400, {"ok": False, "error": "no_valid_symbols"})
            return

        quotes = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as ex:
            fut = {ex.submit(fetch_one, s): s for s in syms}
            for f in concurrent.futures.as_completed(fut, timeout=9):
                s = fut[f]
                try:
                    quotes[s] = f.result()
                except Exception:
                    quotes[s] = None

        hits = sum(1 for v in quotes.values() if v)
        self._json(200, {"ok": True, "quotes": quotes, "hits": hits, "total": len(syms)})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=5")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
