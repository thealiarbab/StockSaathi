"""GET /api/search?q=reli  —  instrument lookup over the NSE universe.

The one thing the public API could not do: take a fragment and suggest a
symbol. `/api/quote`, `/api/live-quote`, `/api/history` and
`/api/fundamentals` all require you to already know the symbol, which is
the hard part for anybody who is not looking at a ticker tape.

The universe already exists -- `admin-sync-instruments` refreshes
`dhan_instruments` nightly from NSE, with symbol, company name, exchange,
ISIN and sector. This reads it.

Reads it with the **service-role key, server-side**. That key never leaves
this function. `dhan_instruments` is behind row level security with no
anon policy, which is correct and should stay that way: the table is the
whole instrument master, and an anon-readable copy is a scrape waiting to
happen. This endpoint is the controlled way through -- one query, capped
at a handful of rows, minimum two characters.

CORS-open like the rest of the public API, so a browser on another origin
can call it directly.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler

SUPA_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPA_SRV = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

# Below two characters every query matches thousands of rows and none of
# them is a suggestion. "a" is not a search.
MIN_QUERY = 2

# What a suggestion list can usefully show. More is a scroll, not a choice.
MAX_RESULTS = 10

# Fetched before ranking, since PostgREST cannot express "symbol prefix
# matches first" and that ordering is most of what makes the list useful.
FETCH = 60

# The universe changes once a day, at most. A minute of shared cache takes
# the repeat keystrokes off the database entirely.
CACHE_SECONDS = 60


def _escape(value):
    """Make a value safe inside a PostgREST `or=(...)` filter.

    Commas and parentheses end the clause, so a query containing one would
    otherwise change the shape of the filter rather than be searched for.
    Doubling quotes and wrapping is what PostgREST's own grammar expects.
    """
    return '"' + value.replace('"', '""') + '"'


def _search(term):
    """Rows from dhan_instruments matching this term, unranked."""
    if not SUPA_URL or not SUPA_SRV:
        return None

    pattern = term.replace("%", "").replace("*", "")
    clause = ",".join([
        f"symbol.ilike.{_escape(pattern + '*')}",
        f"name.ilike.{_escape('*' + pattern + '*')}",
    ])
    query = urllib.parse.urlencode({
        # The column is `exchange_segment` (values like "NSE_EQ"), not
        # `exchange`. PostgREST errors on an unknown column, so the old
        # spelling made every call fail.
        "select": "symbol,name,exchange_segment,isin,sector",
        "is_active": "eq.true",
        "or": f"({clause})",
        "limit": str(FETCH),
    })

    request = urllib.request.Request(
        f"{SUPA_URL}/rest/v1/dhan_instruments?{query}",
        headers={"apikey": SUPA_SRV, "Authorization": f"Bearer {SUPA_SRV}"})
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return json.loads(response.read())
    except (urllib.error.URLError, ValueError, OSError):
        return None


def _rank(rows, term):
    """Best match first.

    An exact symbol beats a symbol that starts with the term, which beats a
    company name that starts with it, which beats a mention anywhere. Typing
    "INFY" should not offer four other companies whose description happens
    to contain the letters.
    """
    upper = term.upper()
    lower = term.lower()

    def score(row):
        symbol = (row.get("symbol") or "").upper()
        name = (row.get("name") or "").lower()
        if symbol == upper:
            return 0
        if symbol.startswith(upper):
            return 1
        if name.startswith(lower):
            return 2
        return 3

    return sorted(rows, key=lambda row: (score(row), row.get("symbol") or ""))


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        term = (params.get("q") or [""])[0].strip()

        if len(term) < MIN_QUERY:
            return self._send(200, {"ok": True, "items": [], "q": term},
                              cache=False)

        rows = _search(term)
        if rows is None:
            # Upstream trouble, not a bad request. Saying so plainly lets a
            # client fall back to free text rather than showing an error for
            # something the person did nothing wrong to cause.
            return self._send(503, {"ok": False, "error": "search_unavailable"},
                              cache=False)

        items = [{
            "symbol": row.get("symbol"),
            "name": row.get("name"),
            "exchange": row.get("exchange_segment"),
            "isin": row.get("isin"),
            "sector": row.get("sector"),
        } for row in _rank(rows, term)[:MAX_RESULTS]]

        self._send(200, {"ok": True, "items": items, "q": term})

    def _send(self, status, payload, cache=True):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header(
            "Cache-Control",
            f"public, max-age={CACHE_SECONDS}" if cache else "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()
