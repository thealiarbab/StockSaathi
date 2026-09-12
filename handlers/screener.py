"""GET /api/screener?metric=fifty_two_week_high&order=desc&limit=12

Deterministic sort across `fundamentals_cache` for the Ask-Saathi sortable
queries ("highest 52w high", "biggest market cap", "lowest PE", etc.).
Bypasses the LLM â€” the LLM has no actual numeric data to sort on, so
asking it "which stocks have the highest 52-week high" produced random
results (the LLM defaulted to whatever was top-ranked by index prominence
in the prefilter, ignoring the actual numeric question).

The frontend's `runAiSearch` detects sortable patterns via regex and
routes here instead of /api/ai. Returns the same shape as
opMarketSearch ({ matches: [SYMBOL...], rationale: "..." }) so the
existing aiSearch render path Just Works.

Allowlisted metrics (must match a column in fundamentals_cache):
  fifty_two_week_high   highest stock has touched in past year
  fifty_two_week_low    lowest stock has touched in past year
  market_cap            total market value
  pe_ratio              trailing P/E
  pb_ratio              price-to-book
  dividend_yield        annualized yield (fraction, e.g. 0.025 = 2.5%)
  beta                  vs Nifty 50
  roe                   return on equity
  eps                   trailing EPS

Rejects unknown metrics with 400. No LLM calls. Sub-100 ms typical.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from urllib.parse import urlparse, parse_qs, quote as url_quote


SUPA_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_KEY = os.environ.get("SUPABASE_ANON_KEY", "").strip() or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

# Whitelist of metrics that map directly to fundamentals_cache columns.
# Anything not in this set is rejected with 400 to prevent SQL-style
# injection via the metric param (PostgREST still URL-encodes, but a
# typo'd metric would just return an empty list silently â€” louder
# rejection is friendlier).
ALLOWED_METRICS = {
    "fifty_two_week_high", "fifty_two_week_low",
    "market_cap", "pe_ratio", "pb_ratio",
    "dividend_yield", "beta", "roe", "eps",
    "debt_to_equity",
    # ETF-specific (Hotfix33b). Stocks have these as null.
    "aum", "expense_ratio", "tracking_error",
}
# Optional kind filter for "biggest ETF" / "most expensive stock" type queries.
# When omitted, screener pulls top-N across STOCK + ETF combined.
ALLOWED_KINDS = {"STOCK", "ETF"}
ALLOWED_ORDER = {"asc", "desc"}
DEFAULT_LIMIT = 12
MAX_LIMIT = 50

# Pretty-print labels for the rationale text. Keys must match ALLOWED_METRICS.
METRIC_LABELS = {
    "fifty_two_week_high": "52-week high",
    "fifty_two_week_low":  "52-week low",
    "market_cap":          "market cap",
    "pe_ratio":            "P/E ratio",
    "pb_ratio":            "P/B ratio",
    "dividend_yield":      "dividend yield",
    "beta":                "beta",
    "roe":                 "return on equity",
    "eps":                 "earnings per share",
    "debt_to_equity":      "debt-to-equity ratio",
    "aum":                 "assets under management",
    "expense_ratio":       "expense ratio",
    "tracking_error":      "tracking error",
}


def _allowed_origin(req_headers):
    origin = req_headers.get("origin", "") or req_headers.get("Origin", "")
    # Mirror the same allowlist as ai.js. Hardcoded for sub-handler simplicity.
    if origin in (
        "https://stocksaathi.co.in",
        "https://www.stocksaathi.co.in",
        "https://stocksaathi.vercel.app",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ):
        return origin
    return ""


def _cors_headers(origin):
    return {
        "Access-Control-Allow-Origin": origin or "*",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Cache-Control": "no-store",
        "Vary": "Origin",
    }


def _send_json(self, status, body, origin):
    self.send_response(status)
    for k, v in _cors_headers(origin).items():
        self.send_header(k, v)
    self.send_header("Content-Type", "application/json")
    payload = json.dumps(body).encode("utf-8")
    self.send_header("Content-Length", str(len(payload)))
    self.end_headers()
    self.wfile.write(payload)


def _query_supabase(metric, order, limit):
    """PostgREST query that selects symbol + name + sector + the metric,
    filters out null metric values (so a 'not yet fetched' row doesn't
    pollute the top 12), and orders + limits server-side."""
    if not (SUPA_URL and SUPA_KEY):
        return None, "supabase_not_configured"
    # `not.is.null` excludes rows where the column is NULL. Combined
    # with the metric ordering this gives a clean top-N of stocks
    # that actually have the data. nullslast is implicit on desc order
    # for PostgREST but we exclude nulls anyway for correctness.
    select_cols = f"symbol,name,sector,{metric}"
    # For valuation ratios sorted ascending, filter to positive values.
    # 'lowest PE' / 'lowest PB' should return cheapest stocks by valuation,
    # not loss-makers with negative PE. Without this filter PAYTM/SWIGGY/
    # IDEA top the 'lowest PE' list â€” mathematically correct but
    # semantically wrong for the typical query intent.
    extra_filters = ""
    if order == "asc" and metric in ("pe_ratio", "pb_ratio"):
        extra_filters = f"&{metric}=gt.0"
    url = (f"{SUPA_URL}/rest/v1/fundamentals_cache"
           f"?select={select_cols}"
           f"&{metric}=not.is.null"
           f"{extra_filters}"
           f"&order={metric}.{order}"
           f"&limit={limit}")
    req = urllib.request.Request(url, headers={
        "apikey": SUPA_KEY,
        "Authorization": f"Bearer {SUPA_KEY}",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=4) as r:
            rows = json.loads(r.read())
        return rows, None
    except urllib.error.HTTPError as e:
        return None, f"supabase_http_{e.code}"
    except Exception as e:
        return None, f"supabase_err_{type(e).__name__}"


# Module-level cache for the static fundamentals JSON. Loaded lazily on
# first fallback miss; subsequent fallbacks reuse the parsed dict.
_STATIC_FUNDAMENTALS = None
_STATIC_FUNDAMENTALS_LOAD_ERR = None


def _load_static_fundamentals():
    """Read js/data/fundamentals_top200.json from the deployed bundle.
    Used as a fallback when fundamentals_cache table is missing or
    empty (which is the current state â€” user hasn't run the migration
    yet)."""
    global _STATIC_FUNDAMENTALS, _STATIC_FUNDAMENTALS_LOAD_ERR
    if _STATIC_FUNDAMENTALS is not None:
        return _STATIC_FUNDAMENTALS
    if _STATIC_FUNDAMENTALS_LOAD_ERR is not None:
        return None
    # Vercel deploys api/ + js/ as siblings under the project root. From
    # api/screener.py, the static JSON is at ../js/data/fundamentals_top200.json
    # â€” but the relative path depends on the runtime cwd. Try a few.
    # Try the full-universe file first (2,363 stocks, every active EQUITY
    # symbol from universeFull.json) and fall back to the smaller top-200
    # file if the full one is missing or corrupted. The full file is
    # ~800 KB raw / ~140 KB brotli â€” cheap enough to ship in the bundle.
    candidates = [
        os.path.join(os.path.dirname(__file__), "..", "js", "data", "fundamentals_full.json"),
        os.path.join(os.getcwd(), "js", "data", "fundamentals_full.json"),
        os.path.join("/var/task", "js", "data", "fundamentals_full.json"),
        os.path.join(os.path.dirname(__file__), "..", "js", "data", "fundamentals_top200.json"),
        os.path.join(os.getcwd(), "js", "data", "fundamentals_top200.json"),
        os.path.join("/var/task", "js", "data", "fundamentals_top200.json"),
    ]
    for p in candidates:
        try:
            with open(p, "r", encoding="utf-8") as f:
                payload = json.load(f)
            _STATIC_FUNDAMENTALS = payload
            return payload
        except FileNotFoundError:
            continue
        except Exception as e:
            _STATIC_FUNDAMENTALS_LOAD_ERR = str(e)[:80]
            return None
    _STATIC_FUNDAMENTALS_LOAD_ERR = "static_json_not_found"
    return None


def _query_static(metric, order, limit, kind=None):
    """Sort the in-memory static JSON by the requested metric. Mirrors
    the shape that _query_supabase returns so the handler can swap
    between sources transparently. Optional kind filter restricts to
    'STOCK' or 'ETF' rows; absence means all instrument kinds."""
    payload = _load_static_fundamentals()
    if not payload:
        return None, _STATIC_FUNDAMENTALS_LOAD_ERR or "static_unavailable"
    stocks = (payload.get("stocks") or {}).values()
    # Filter out rows missing the metric (mirrors not.is.null in PostgREST).
    valid = [s for s in stocks if s.get(metric) is not None]
    # Optional kind filter ('biggest ETF AUM' query → kind=ETF).
    if kind:
        valid = [s for s in valid if (s.get("kind") or "STOCK").upper() == kind.upper()]
    # Mirror the same positive-only filter the Supabase query applies for
    # valuation ratios sorted ascending (avoids PAYTM/SWIGGY topping
    # 'lowest PE' on loss-maker negative values).
    if order == "asc" and metric in ("pe_ratio", "pb_ratio", "expense_ratio"):
        valid = [s for s in valid if s.get(metric) > 0]
    valid.sort(key=lambda s: s.get(metric), reverse=(order == "desc"))
    rows = valid[:limit]
    return rows, None


def _format_value(metric, val):
    """Human-readable rendering of a metric value for the rationale string."""
    if val is None:
        return ""
    if metric in ("fifty_two_week_high", "fifty_two_week_low"):
        return f"â‚¹{val:,.0f}"
    if metric in ("market_cap", "aum"):
        # Both rendered as crores. AUM is fund-side market cap for ETFs.
        crore = val / 1e7
        if crore >= 100000:
            return f"â‚¹{crore/100000:.1f}L cr"
        return f"â‚¹{crore:,.0f} cr"
    if metric == "dividend_yield":
        return f"{val*100:.2f}%"
    if metric == "expense_ratio":
        return f"{val:.2f}%"
    if metric == "tracking_error":
        return f"{val:.3f}%"
    if metric in ("pe_ratio", "pb_ratio", "beta", "eps", "debt_to_equity"):
        return f"{val:.2f}"
    if metric == "roe":
        return f"{val*100:.1f}%" if abs(val) < 1 else f"{val:.1f}%"
    return str(val)


def _build_rationale(metric, order, rows, source=None):
    if not rows:
        # Specific guidance for the common gap: debt_to_equity isn't in
        # the static JSON sidecar (Tickertape's ratios endpoint doesn't
        # ship it; only Yahoo v10 does). Once the user runs the
        # fundamentals_cache migration + admin-sync-fundamentals cron,
        # debt populates and this branch goes quiet.
        if metric == "debt_to_equity" and source in ("static_top200", "static_full"):
            return ("Debt-to-equity data isn't in the static fallback "
                    "(Tickertape's ratios endpoint doesn't ship it). Will "
                    "populate once the Supabase fundamentals_cache table is "
                    "populated by the daily Yahoo-v10 cron.")
        return f"No stocks with {METRIC_LABELS.get(metric, metric)} data in the universe yet."
    label = METRIC_LABELS.get(metric, metric)
    direction = "highest" if order == "desc" else "lowest"
    top_sample = rows[:3]
    bits = [f"{r['symbol']} ({_format_value(metric, r.get(metric))})" for r in top_sample]
    return f"Top {len(rows)} by {direction} {label}: {', '.join(bits)}"


from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        origin = _allowed_origin(self.headers)
        self.send_response(204)
        for k, v in _cors_headers(origin).items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        origin = _allowed_origin(self.headers)
        try:
            qs = parse_qs(urlparse(self.path).query)
            metric = (qs.get("metric", [""])[0] or "").strip().lower()
            order = (qs.get("order", ["desc"])[0] or "desc").strip().lower()
            kind = (qs.get("kind", [""])[0] or "").strip().upper() or None
            try:
                limit = int(qs.get("limit", [str(DEFAULT_LIMIT)])[0])
            except (TypeError, ValueError):
                limit = DEFAULT_LIMIT
            limit = max(1, min(limit, MAX_LIMIT))

            if metric not in ALLOWED_METRICS:
                _send_json(self, 400, {
                    "error": "bad_metric",
                    "allowed": sorted(list(ALLOWED_METRICS)),
                }, origin)
                return
            if order not in ALLOWED_ORDER:
                _send_json(self, 400, {"error": "bad_order"}, origin)
                return
            if kind and kind not in ALLOWED_KINDS:
                _send_json(self, 400, {"error": "bad_kind", "allowed": sorted(list(ALLOWED_KINDS))}, origin)
                return

            # Try Supabase first; if the table is missing/empty/unreachable
            # OR returns zero rows, fall back to the static fundamentals
            # sidecar shipped at js/data/fundamentals_top200.json. Both
            # sources return the same row shape, so the rest of the handler
            # is source-agnostic.
            source = "supabase"
            # Supabase path doesn't support kind filter yet (the table
            # only stores stocks, not ETFs). When a kind filter is
            # present, skip Supabase and go straight to the static path.
            rows, err = (None, "kind_filter_no_supabase") if kind else _query_supabase(metric, order, limit)
            if err or not rows:
                rows, static_err = _query_static(metric, order, limit, kind=kind)
                if static_err and not rows:
                    _send_json(self, 502, {
                        "error": err or static_err,
                        "supabase_err": err,
                        "static_err": static_err,
                    }, origin)
                    return
                # Determine which static file backed the result so the
                # rationale can mention coverage limits accurately.
                payload = _STATIC_FUNDAMENTALS or {}
                source = "static_full" if len(payload.get("stocks") or {}) > 1000 else "static_top200"
            matches = [r["symbol"] for r in (rows or []) if r.get("symbol")]
            rationale = _build_rationale(metric, order, rows or [], source=source)
            _send_json(self, 200, {
                "matches": matches,
                "rationale": rationale,
                "metric": metric,
                "order": order,
                "source": source,
            }, origin)
        except Exception as e:
            _send_json(self, 500, {"error": "handler_err", "detail": str(e)[:120]}, origin)
