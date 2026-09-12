"""GET /api/history?symbol=RELIANCE&range=1mo&interval=1d

Clean candlestick / history endpoint. Replaces the flaky
/api/yahoo/chart/* catch-all route (which Vercel wasn't matching) and the
browser-side direct-Yahoo fetch (CORS-blocked).

Normalized output for the frontend:
  {
    "ok": true,
    "symbol": "RELIANCE",
    "ticker": "RELIANCE.NS",
    "range": "1mo",
    "interval": "1d",
    "ohlc": [ { "t": 1776432000000, "o": 79510, "h": 79945, "l": 78920,
                "c": 79545, "v": 12038472 }, ... ],
    "currency": "INR",
    "ts_ms": 1776683897000
  }

Prices are in PAISE (integer) to keep all math in the frontend integer-safe.
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

YAHOO_HOSTS = [
    "https://query1.finance.yahoo.com/v8/finance/chart",
    "https://query2.finance.yahoo.com/v8/finance/chart",
]

_SYMBOL_RE = re.compile(r"^[A-Z0-9.\-\^=_&]{1,24}$")
_RANGE_RE = re.compile(r"^(1d|5d|1mo|3mo|6mo|1y|2y|5y|10y|ytd|max)$")
_INTERVAL_RE = re.compile(r"^(1m|2m|5m|15m|30m|60m|90m|1h|1d|5d|1wk|1mo|3mo)$")

# Sensible default (range, interval) for each UI timeframe the frontend uses.
# Clients can override via query; server just validates the allow-list.
DEFAULT_RANGE = "1mo"
DEFAULT_INTERVAL = "1d"

# Intraday intervals only work for ranges <= 60d per Yahoo; the UI already
# picks valid pairs, but we enforce compatibility server-side too.
_INTRADAY = {"1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h"}


def fetch_yahoo(symbol, range_, interval, period1=None, period2=None):
    """Yahoo /v8 chart fetch. Either pass `range_` (preset) OR `period1`+
    `period2` (custom epoch-second range). Custom range takes precedence
    when both are provided."""
    # BSE-only listings 404 on ".NS" — try NSE first, then ".BO". See the
    # same fallback in quote.py / quotes.py / live-quote.py.
    tickers = [symbol] if "." in symbol else [f"{symbol}.NS", f"{symbol}.BO"]
    for ticker, base in ((t, b) for t in tickers for b in YAHOO_HOSTS):
        if period1 and period2:
            url = f"{base}/{url_quote(ticker, safe='.')}?interval={interval}&period1={int(period1)}&period2={int(period2)}"
        else:
            url = f"{base}/{url_quote(ticker, safe='.')}?interval={interval}&range={range_}"
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "application/json,text/plain,*/*",
                "Accept-Language": "en-US,en;q=0.9",
            })
            with urllib.request.urlopen(req, timeout=8) as r:
                data = json.loads(r.read())
        except Exception:
            continue
        result = ((data.get("chart") or {}).get("result") or [None])[0]
        if not result:
            continue
        timestamps = result.get("timestamp") or []
        q = (result.get("indicators", {}).get("quote") or [{}])[0]
        closes = q.get("close") or []
        opens = q.get("open") or []
        highs = q.get("high") or []
        lows = q.get("low") or []
        volumes = q.get("volume") or []
        meta = result.get("meta") or {}
        ohlc = []
        for i in range(len(timestamps)):
            c = closes[i] if i < len(closes) else None
            o = opens[i] if i < len(opens) else None
            h = highs[i] if i < len(highs) else None
            l = lows[i] if i < len(lows) else None
            v = volumes[i] if i < len(volumes) else 0
            # Skip no-trade gaps (nulls) so the chart doesn't break at weekends.
            if c is None or o is None or h is None or l is None:
                continue
            ohlc.append({
                "t": int(timestamps[i]) * 1000,
                "o": int(round(o * 100)),
                "h": int(round(h * 100)),
                "l": int(round(l * 100)),
                "c": int(round(c * 100)),
                "v": int(v or 0),
            })
        if not ohlc:
            continue
        return {
            "ohlc": ohlc,
            "currency": meta.get("currency") or "INR",
            "exchange": meta.get("exchangeName") or "",
            "host": base.split("//")[1].split("/")[0],
        }
    return None


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        symbol = (q.get("symbol") or [""])[0].strip().upper()
        range_ = (q.get("range") or [DEFAULT_RANGE])[0].strip()
        interval = (q.get("interval") or [DEFAULT_INTERVAL])[0].strip()
        # Hotfix48a: optional custom date range. When BOTH from and to are
        # provided as YYYY-MM-DD strings, build period1/period2 epoch
        # seconds and ignore range. Lets the frontend custom-range picker
        # (Hotfix48b) request arbitrary windows â€” useful for users who
        # want to inspect a specific event period (Adani Hindenburg week,
        # COVID crash, etc.) instead of being capped at preset 1D-MAX.
        from_str = (q.get("from") or [""])[0].strip()
        to_str   = (q.get("to")   or [""])[0].strip()
        custom_range = bool(from_str and to_str)

        if not symbol or not _SYMBOL_RE.match(symbol):
            self._json(400, {"ok": False, "error": "bad_symbol"})
            return
        # Mutual funds have no Yahoo coverage — MF_<amfi_code>.NS isn't a
        # valid ticker. Reject early instead of letting the request burn
        # 5 seconds hitting query1.finance.yahoo.com only to 404. Front-end
        # should call /api/mf-history for MFs (mfapi.in proxy).
        if symbol.startswith("MF_"):
            self._json(400, {"ok": False, "error": "mf_use_mf_history",
                             "detail": "Use /api/mf-history?code=<amfi_code>"})
            return
        if not _INTERVAL_RE.match(interval):
            self._json(400, {"ok": False, "error": "bad_interval"})
            return

        period1 = period2 = None
        if custom_range:
            try:
                from datetime import datetime, timezone
                dt_from = datetime.fromisoformat(from_str).replace(tzinfo=timezone.utc)
                dt_to   = datetime.fromisoformat(to_str).replace(tzinfo=timezone.utc)
            except Exception:
                self._json(400, {"ok": False, "error": "bad_dates",
                                 "detail": "from/to must be YYYY-MM-DD"})
                return
            if dt_to <= dt_from:
                self._json(400, {"ok": False, "error": "bad_range",
                                 "detail": "to must be after from"})
                return
            # Cap at 10 years — Yahoo silently truncates anything older.
            if (dt_to - dt_from).days > 366 * 10:
                self._json(400, {"ok": False, "error": "range_too_long",
                                 "detail": "max 10 years"})
                return
            period1 = int(dt_from.timestamp())
            # period2 inclusive of the to-date: add one day so the
            # last day's candle isn't cut off.
            period2 = int(dt_to.timestamp()) + 86400
            # Intraday intervals don't make sense for multi-month ranges
            # â€” Yahoo will return empty. Force a daily interval if the
            # user asked for an intraday one on a long custom range.
            if interval in _INTRADAY and (dt_to - dt_from).days > 60:
                interval = "1d"
        else:
            if not _RANGE_RE.match(range_):
                self._json(400, {"ok": False, "error": "bad_range"})
                return
            # Lightly guard against intraday + long-range combos Yahoo will reject.
            if interval in _INTRADAY and range_ not in ("1d", "5d", "1mo"):
                self._json(400, {"ok": False, "error": "interval_incompatible_with_range"})
                return

        data = fetch_yahoo(symbol, range_, interval, period1=period1, period2=period2)
        if not data:
            self._json(502, {"ok": False, "error": "yahoo_unreachable"})
            return

        import time
        self._json(200, {
            "ok": True,
            "symbol": symbol,
            "ticker": symbol if "." in symbol else f"{symbol}.NS",
            "range": range_ if not custom_range else f"{from_str}_{to_str}",
            "interval": interval,
            "ohlc": data["ohlc"],
            "currency": data.get("currency", "INR"),
            "exchange": data.get("exchange"),
            "ts_ms": int(time.time() * 1000),
            "source": "yahoo_v8_chart",
            "host": data.get("host"),
        })

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        # Daily candles barely change intraday; intraday candles change every
        # minute. 60s edge cache balances both.
        self.send_header("Cache-Control", "public, max-age=60")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
