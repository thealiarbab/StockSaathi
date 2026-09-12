"""GET/POST /api/admin-refresh-fundamentals â€” auto-refresh fundamentals_full.json
via Vercel cron + commit-back to GitHub.

Triggered hourly (or daily) by a Vercel cron entry in vercel.json.
Performs the same Tickertape fetch as scripts/refresh-fundamentals.py
but, instead of writing to local disk (Vercel functions are stateless),
commits the result back to GitHub via the contents API. Vercel auto-
deploys on the new commit; screener serves fresh data on next request.

Auth:
  Vercel cron auto-injects an Authorization: Bearer <CRON_SECRET> header.
  Manual triggers must include either:
    Authorization: Bearer <CRON_SECRET>      â€” for scheduled cron
    Authorization: Bearer <ADMIN_TOKEN>      â€” for manual trigger

Required env vars:
  GITHUB_PAT             â€” personal access token with `repo:contents:write`
                            scope on Ali-Arbab/StockSaathi
  CRON_SECRET            â€” auto-injected by Vercel cron OR set manually
                            for ad-hoc trigger
  GITHUB_OWNER           â€” defaults to "Ali-Arbab"
  GITHUB_REPO            â€” defaults to "StockSaathi"
  GITHUB_BRANCH          â€” defaults to "main"

If GITHUB_PAT is missing the function still runs the fetch and returns
the JSON inline â€” useful for testing without committing. Just doesn't
persist.

Vercel maxDuration is 60s. The full stock+ETF fetch usually completes
in ~60s with 8 parallel workers. If it times out, you lose this run
but the next cron pickup gets it. Idempotent.
"""
import base64
import json
import os
import sys
import time
import ssl
import urllib.request
import urllib.error
from urllib.parse import urlparse, parse_qs, quote as url_quote
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler


SSL_CTX = ssl._create_unverified_context()
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
TT_HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json",
    "Origin": "https://www.tickertape.in",
    "Referer": "https://www.tickertape.in/",
}

CRON_SECRET = os.environ.get("CRON_SECRET", "").strip()
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()
GITHUB_PAT  = os.environ.get("GITHUB_PAT", "").strip()
GITHUB_OWNER  = os.environ.get("GITHUB_OWNER",  "Ali-Arbab").strip()
GITHUB_REPO   = os.environ.get("GITHUB_REPO",   "StockSaathi").strip()
GITHUB_BRANCH = os.environ.get("GITHUB_BRANCH", "main").strip()
TARGET_PATH   = "js/data/fundamentals_full.json"


def _http_get(url, headers=None, timeout=10):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
        return json.loads(r.read())


def _tt_get(url, timeout=10):
    try:
        return _http_get(url, headers=TT_HEADERS, timeout=timeout)
    except Exception:
        return None


def _lookup_sid(symbol, kind="stock"):
    url = f"https://api.tickertape.in/stocks/search?text={url_quote(symbol)}&types={kind}&pageNumber=0"
    p = _tt_get(url)
    if not p or not p.get("success"):
        return None
    for r in (p.get("data") or {}).get("searchResults") or []:
        info = (r.get("stock") or {}).get("info") or {}
        if (info.get("ticker") or "").upper() == symbol.upper() \
           and (info.get("exchange") or "").upper() == "NSE":
            return r.get("sid")
    for r in (p.get("data") or {}).get("searchResults") or []:
        info = (r.get("stock") or {}).get("info") or {}
        if (info.get("exchange") or "").upper() == "NSE":
            return r.get("sid")
    return None


def _fetch_one(symbol, kind="stock"):
    sid = _lookup_sid(symbol, kind=kind)
    if not sid and kind == "etf":
        sid = _lookup_sid(symbol, kind="stock")
    if not sid:
        return symbol, None
    url = f"https://api.tickertape.in/stocks/info/{url_quote(sid)}?types=ratios"
    p = _tt_get(url)
    if not p or not p.get("success"):
        return symbol, None
    data = p.get("data") or {}
    ratios = data.get("ratios") or {}
    info = data.get("info") or {}
    if not ratios:
        return symbol, None
    mcap_cr = ratios.get("marketCap")
    market_cap = float(mcap_cr) * 1e7 if mcap_cr is not None else None
    aum_cr = ratios.get("asstUnderMan")
    aum = float(aum_cr) * 1e7 if aum_cr is not None else None
    def pct(v): return float(v)/100.0 if v is not None else None
    row = {
        "symbol": symbol,
        "kind": kind.upper(),
        "name": info.get("name"),
        "sector": info.get("sector"),
        "market_cap": market_cap,
        "pe_ratio": ratios.get("ttmPe") or ratios.get("pe"),
        "pb_ratio": ratios.get("pb"),
        "beta": ratios.get("beta"),
        "dividend_yield": pct(ratios.get("divYield")),
        "eps": ratios.get("eps"),
        "roe": pct(ratios.get("roe")),
        "fifty_two_week_high": ratios.get("52wHigh"),
        "fifty_two_week_low":  ratios.get("52wLow"),
        "last_price": ratios.get("lastPrice"),
    }
    if kind == "etf":
        row["aum"] = aum
        row["expense_ratio"]  = ratios.get("expenseRatio")
        row["tracking_error"] = ratios.get("trackErr")
    return symbol, row


def _read_universe_symbols():
    """Read js/data/universeFull.json from the deployed bundle. Same path-
    candidate dance as screener.py."""
    candidates = [
        os.path.join(os.path.dirname(__file__), "..", "js", "data", "universeFull.json"),
        os.path.join(os.getcwd(), "js", "data", "universeFull.json"),
        "/var/task/js/data/universeFull.json",
    ]
    for p in candidates:
        try:
            data = json.load(open(p, "r", encoding="utf-8"))
            stocks = sorted({r["symbol"] for r in data if r.get("kind") == "EQUITY"})
            etfs   = sorted({r["symbol"] for r in data if r.get("kind") == "ETF"})
            return stocks, etfs, None
        except FileNotFoundError:
            continue
        except Exception as e:
            return [], [], f"universe_read_err: {e}"
    return [], [], "universe_not_found"


def _fetch_batch(syms, kind, max_workers=10, deadline_ms=None):
    out = {}
    with ThreadPoolExecutor(max_workers=max_workers) as exe:
        futures = {exe.submit(_fetch_one, s, kind): s for s in syms}
        for fut in as_completed(futures):
            if deadline_ms and (time.time() * 1000) > deadline_ms:
                # Time's up â€” cancel pending and return partial.
                for f in futures:
                    if not f.done():
                        f.cancel()
                break
            sym, row = fut.result()
            if row:
                out[sym] = row
    return out


def _gh_get_sha():
    """Fetch the current SHA of the target file so we can pass it to PUT."""
    if not GITHUB_PAT:
        return None, "no_github_pat"
    url = (f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/contents/"
           f"{url_quote(TARGET_PATH)}?ref={url_quote(GITHUB_BRANCH)}")
    headers = {
        "Authorization": f"Bearer {GITHUB_PAT}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "stocksaathi-cron",
    }
    try:
        d = _http_get(url, headers=headers, timeout=8)
        return d.get("sha"), None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, None  # New file, no SHA needed.
        return None, f"gh_get_sha_{e.code}"
    except Exception as e:
        return None, f"gh_get_sha_err: {e}"


def _gh_commit_file(content_bytes, message):
    if not GITHUB_PAT:
        return False, "no_github_pat"
    sha, err = _gh_get_sha()
    if err:
        return False, err
    body = {
        "message": message,
        "content": base64.b64encode(content_bytes).decode("ascii"),
        "branch":  GITHUB_BRANCH,
    }
    if sha:
        body["sha"] = sha
    url = (f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/contents/"
           f"{url_quote(TARGET_PATH)}")
    headers = {
        "Authorization": f"Bearer {GITHUB_PAT}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "stocksaathi-cron",
    }
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                 headers=headers, method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=15, context=SSL_CTX) as r:
            r.read()
        return True, None
    except urllib.error.HTTPError as e:
        return False, f"gh_put_{e.code}: {e.read()[:200].decode('utf-8','replace')}"
    except Exception as e:
        return False, f"gh_put_err: {e}"


def _check_auth(headers):
    auth = headers.get("authorization", "") or headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:].strip()
        if token and (token == CRON_SECRET or token == ADMIN_TOKEN):
            return True
    return False


def _send(self, status, body):
    self.send_response(status)
    self.send_header("Content-Type", "application/json")
    self.send_header("Cache-Control", "no-store")
    payload = json.dumps(body).encode("utf-8")
    self.send_header("Content-Length", str(len(payload)))
    self.end_headers()
    self.wfile.write(payload)


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204); self.end_headers()

    def _run(self):
        if not _check_auth(self.headers):
            _send(self, 401, {"error": "unauthorized"})
            return

        # Parse query params
        qs = parse_qs(urlparse(self.path).query)
        skip_etfs = qs.get("skip_etfs", ["0"])[0] == "1"

        t0 = time.time()
        # Reserve last 5s of the 60s window for the GitHub commit.
        deadline_ms = int((t0 + 50) * 1000)

        stocks, etfs, err = _read_universe_symbols()
        if err:
            _send(self, 500, {"error": err}); return

        out = _fetch_batch(stocks, "stock", max_workers=10, deadline_ms=deadline_ms)
        # Ensure kind=STOCK on stock entries (fetch_one already sets it,
        # but be explicit for safety in case Tickertape changes shape).
        for r in out.values():
            r.setdefault("kind", "STOCK")

        etf_count = 0
        if not skip_etfs and (time.time() * 1000) < deadline_ms:
            etf_out = _fetch_batch(etfs, "etf", max_workers=10, deadline_ms=deadline_ms)
            out.update(etf_out)
            etf_count = len(etf_out)

        payload = {
            "generated_at_ms": int(time.time() * 1000),
            "source": "tickertape",
            "stocks": out,
        }
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        elapsed = round(time.time() - t0, 1)

        ok, gh_err = _gh_commit_file(
            body,
            f"auto-refresh fundamentals_full.json ({len(out)} entries, {elapsed}s)"
        )
        result = {
            "ok": True,
            "stocks_fetched": len([r for r in out.values() if r.get("kind") == "STOCK"]),
            "etfs_fetched":   etf_count,
            "total_entries":  len(out),
            "elapsed_seconds": elapsed,
            "github_committed": ok,
            "github_error": gh_err,
        }
        _send(self, 200, result)

    def do_GET(self):  self._run()
    def do_POST(self): self._run()
