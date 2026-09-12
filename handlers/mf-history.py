"""GET /api/mf-history?code=<amfi_code>&tf=<1M|3M|6M|1Y|3Y|5Y|ALL>

Server-side proxy for https://api.mfapi.in/mf/<code> — the unofficial AMFI
NAV history API. Returns daily NAV history as the same OHLC shape that
/api/history returns for equities, so the front-end chart code can drop
in interchangeably.

NAVs are daily (one entry per business day), so all four OHLC legs equal
that day's NAV (open=high=low=close). Volume is always 0 (MFs don't have
exchange volume). Prices are returned in PAISE — matches the rest of our
pipeline so formatRupees(c)/100 math just works.

Response shape:
  {
    "ok":               true,
    "amfi_code":        "118718",
    "scheme_name":      "Aditya Birla Sun Life Money Market Fund - Direct - Growth",
    "scheme_category":  "Debt Scheme - Money Market Fund",
    "fund_house":       "Aditya Birla Sun Life Mutual Fund",
    "tf":               "1Y",
    "ohlc":             [{ "t": <epoch_ms>, "o": <paise>, "h": <paise>, "l": <paise>, "c": <paise>, "v": 0 }, ...],
    "asof_date":        "24-04-2026",
    "latest_nav_paise": 50024,
    "ts_ms":            <epoch_ms>
  }

mfapi.in is free, no auth, CORS-open, and reasonably reliable. The proxy
gives us:
  - 1-hour edge cache (NAVs only update once daily ~9 PM IST), so spike
    of users hitting an MF detail page doesn't hammer the upstream
  - Slicing by timeframe instead of always shipping ~3,500 rows
  - Robustness against malformed dates / NaN navs in the upstream feed
  - Consistent paise-int output (mfapi.in returns NAV as a float string)
"""

import re
import json
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# Real AMFI scheme codes are 5–6 digits; pad allowance for safety.
_CODE_RE = re.compile(r"^\d{1,6}$")

_VALID_TF = {"1M", "3M", "6M", "1Y", "3Y", "5Y", "ALL"}

# How many calendar days each TF covers. Data is trading-days only, so we
# slice by calendar offset against the most-recent NAV date.
_TF_DAYS = {
    "1M":  30,
    "3M":  91,
    "6M":  182,
    "1Y":  365,
    "3Y":  1095,
    "5Y":  1825,
    "ALL": None,      # return everything
}

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)


def _parse_dd_mm_yyyy(s):
    """Parse 'DD-MM-YYYY' → epoch_ms. Returns None on any error."""
    try:
        day, mon, year = s.split("-")
        # Use UTC midnight; the date itself is what matters for charting,
        # not the time-of-day component.
        ts = time.mktime(time.strptime(f"{year}-{mon}-{day}T00:00:00Z",
                                       "%Y-%m-%dT%H:%M:%SZ"))
        return int(ts * 1000)
    except (ValueError, TypeError, AttributeError):
        return None


def _nav_to_paise(nav_str):
    """Convert NAV string ('498.6201') → integer paise. Returns None if invalid."""
    try:
        f = float(nav_str)
        # Catches NaN, 0, negative — all garbage we don't want on a chart.
        if not (f > 0):
            return None
        return int(round(f * 100))
    except (ValueError, TypeError):
        return None


def fetch_mf_history(amfi_code):
    """Hits mfapi.in/mf/<code> and returns a normalised dict, or None on failure.

    mfapi.in response: { meta: {...}, data: [{date: "DD-MM-YYYY", nav: "123.45"}, ...] }
    Data is newest-first.
    """
    url = f"https://api.mfapi.in/mf/{amfi_code}"
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read()
    except (urllib.error.URLError, urllib.error.HTTPError, OSError):
        return None
    except Exception:
        return None

    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return None

    meta = payload.get("meta") or {}
    data = payload.get("data")
    if not isinstance(data, list) or not data:
        return None

    return {
        "scheme_name":     meta.get("scheme_name", ""),
        "scheme_category": meta.get("scheme_category", ""),
        "fund_house":      meta.get("fund_house", ""),
        "data":            data,   # raw list, newest-first
    }


def build_ohlc(raw_data, tf):
    """raw_data is mfapi.in's data list (newest-first).

    Returns (ohlc_list_oldest_first, asof_date_str, latest_nav_paise).
    Skips malformed entries silently rather than failing the whole response.
    """
    days = _TF_DAYS.get(tf)
    cutoff_ms = None
    if days is not None and raw_data:
        latest_t = _parse_dd_mm_yyyy(raw_data[0].get("date", ""))
        if latest_t is not None:
            cutoff_ms = latest_t - (days * 86_400_000)

    ohlc = []
    for entry in raw_data:
        t = _parse_dd_mm_yyyy(entry.get("date", ""))
        p = _nav_to_paise(entry.get("nav", ""))
        if t is None or p is None:
            continue
        if cutoff_ms is not None and t < cutoff_ms:
            # Data is newest-first; once past cutoff we're done.
            break
        ohlc.append({"t": t, "o": p, "h": p, "l": p, "c": p, "v": 0})

    # Reverse → oldest-first (standard chart convention).
    ohlc.reverse()

    asof_date        = raw_data[0].get("date", "") if raw_data else ""
    latest_nav_paise = _nav_to_paise(raw_data[0].get("nav", "")) if raw_data else None

    return ohlc, asof_date, latest_nav_paise


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        code = (q.get("code") or [""])[0].strip()
        tf   = (q.get("tf")   or ["1Y"])[0].strip().upper()

        if not code or not _CODE_RE.match(code):
            self._json(400, {"ok": False, "error": "bad_code",
                             "detail": "code must be 1–6 digits"})
            return

        if tf not in _VALID_TF:
            tf = "1Y"   # silently clamp unknown values

        raw = fetch_mf_history(code)
        if raw is None:
            self._json(502, {"ok": False, "error": "mfapi_unreachable",
                             "detail": f"Could not reach api.mfapi.in/mf/{code}"})
            return

        if not raw["data"]:
            self._json(404, {"ok": False, "error": "no_data",
                             "detail": f"mfapi.in returned empty data for code {code}"})
            return

        ohlc, asof_date, latest_nav_paise = build_ohlc(raw["data"], tf)
        if not ohlc:
            self._json(404, {"ok": False, "error": "empty_after_slice",
                             "detail": f"No NAV entries found in the {tf} window"})
            return

        self._json(200, {
            "ok":               True,
            "amfi_code":        code,
            "scheme_name":      raw["scheme_name"],
            "scheme_category":  raw["scheme_category"],
            "fund_house":       raw["fund_house"],
            "tf":               tf,
            "ohlc":             ohlc,
            "asof_date":        asof_date,
            "latest_nav_paise": latest_nav_paise,
            "ts_ms":            int(time.time() * 1000),
        })

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Access-Control-Allow-Origin", "*")
        # NAVs publish once per day (~9 PM IST). 1-hour edge cache balances
        # freshness (same-day NAVs visible within an hour) against cost
        # (avoids hammering mfapi.in with the same query).
        self.send_header("Cache-Control",
                         "public, max-age=3600, stale-while-revalidate=7200")
        self.end_headers()
        self.wfile.write(body)
