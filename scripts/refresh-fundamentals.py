"""Refresh fundamentals_full.json from Tickertape.

Run this whenever you want fresh fundamentals (PE, market cap, 52w high,
ETF AUM, expense ratio, etc.) backing the Ask Saathi screener. Tickertape
is the same data source the rest of the app reads via /api/fundamentals.

Usage:
    cd <repo-root>
    python scripts/refresh-fundamentals.py

What it does:
    1. Reads symbols from js/data/universeFull.json (EQUITY + ETF kinds).
    2. Fetches fundamentals from api.tickertape.in for each (8 parallel
       workers, ~60 seconds for ~2700 instruments).
    3. Writes js/data/fundamentals_full.json with the merged result.
    4. You git commit + push the file. Vercel auto-deploys; the screener
       picks up the fresh data on next request.

Frequency: Run when you want fresh data. Daily is plenty â€” fundamentals
change slowly. Live PRICES are real-time via subscribeToQuotes (10-second
polling on visible cards), independent of this script.

Cron path: vercel.json's /api/admin-refresh-fundamentals cron does this
automatically (Hotfix33e) â€” commits-back via GitHub API. Set GITHUB_PAT
in Vercel env vars to enable.
"""
import json
import ssl
import sys
import time
import urllib.request
import urllib.error
from urllib.parse import quote as urlquote
from concurrent.futures import ThreadPoolExecutor, as_completed

# Windows Python ships without a usable cert bundle for system Pythons; bypass.
SSL_CTX = ssl._create_unverified_context()

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.tickertape.in",
    "Referer": "https://www.tickertape.in/",
}


def http_get(url, timeout=10):
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
            return json.loads(r.read().decode("utf-8", errors="replace"))
    except Exception as e:
        return None


def lookup_sid(symbol, kind="stock"):
    """Resolve symbol -> Tickertape sid. kind='stock' or 'etf'."""
    url = f"https://api.tickertape.in/stocks/search?text={urlquote(symbol)}&types={kind}&pageNumber=0"
    p = http_get(url)
    if not p or not p.get("success"):
        return None
    results = (p.get("data") or {}).get("searchResults") or []
    for r in results:
        info = (r.get("stock") or {}).get("info") or {}
        if (info.get("ticker") or "").upper() == symbol.upper() \
           and (info.get("exchange") or "").upper() == "NSE":
            return r.get("sid")
    for r in results:
        info = (r.get("stock") or {}).get("info") or {}
        if (info.get("exchange") or "").upper() == "NSE":
            return r.get("sid")
    return None


def fetch_one(symbol, kind="stock"):
    sid = lookup_sid(symbol, kind=kind)
    if not sid:
        # ETF lookup falls back to stock-style search (some BeES-family
        # tickers resolve via the stock index even with kind=etf).
        if kind == "etf":
            sid = lookup_sid(symbol, kind="stock")
        if not sid:
            return symbol, None
    url = f"https://api.tickertape.in/stocks/info/{urlquote(sid)}?types=ratios"
    p = http_get(url)
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
    def pct_to_frac(v):
        return float(v) / 100.0 if v is not None else None
    row = {
        "symbol": symbol,
        "kind": kind.upper(),
        "name": info.get("name"),
        "sector": info.get("sector"),
        "market_cap": market_cap,
        "pe_ratio": ratios.get("ttmPe") or ratios.get("pe"),
        "pb_ratio": ratios.get("pb"),
        "beta": ratios.get("beta"),
        "dividend_yield": pct_to_frac(ratios.get("divYield")),
        "eps": ratios.get("eps"),
        "roe": pct_to_frac(ratios.get("roe")),
        "fifty_two_week_high": ratios.get("52wHigh"),
        "fifty_two_week_low": ratios.get("52wLow"),
        "last_price": ratios.get("lastPrice"),
    }
    if kind == "etf":
        row["aum"] = aum
        row["expense_ratio"] = ratios.get("expenseRatio")
        row["tracking_error"] = ratios.get("trackErr")
    return symbol, row


def _read_universe(repo_root):
    """Returns (stock_syms, etf_syms) from js/data/universeFull.json."""
    p = os.path.join(repo_root, "js", "data", "universeFull.json")
    # Rows kept only for their holders (listed: false) have no quotes to fetch.
    data = [r for r in json.load(open(p, "r", encoding="utf-8")) if r.get("listed") is not False]
    stocks = sorted({r["symbol"] for r in data if r.get("kind") == "EQUITY"})
    etfs   = sorted({r["symbol"] for r in data if r.get("kind") == "ETF"})
    return stocks, etfs


def _fetch_batch(syms, kind, workers=8):
    out = {}
    failed = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as exe:
        futures = {exe.submit(fetch_one, s, kind): s for s in syms}
        for i, fut in enumerate(as_completed(futures), 1):
            sym, row = fut.result()
            if row:
                out[sym] = row
            else:
                failed.append(sym)
            if i % 50 == 0:
                print(f"  {kind} {i}/{len(syms)} ({time.time()-t0:.1f}s)", file=sys.stderr)
    print(f"  {kind} done. {len(out)} ok, {len(failed)} failed in {time.time()-t0:.1f}s", file=sys.stderr)
    return out, failed


def main():
    # Find the repo root: this script lives at <root>/scripts/, so root
    # is the parent of __file__'s directory. Lets you run from anywhere.
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    out_path = os.path.join(repo_root, "js", "data", "fundamentals_full.json")

    print(f"Reading universe from {repo_root}/js/data/universeFull.json", file=sys.stderr)
    stocks, etfs = _read_universe(repo_root)
    print(f"  {len(stocks)} stocks, {len(etfs)} ETFs to fetch", file=sys.stderr)

    print(f"Fetching stocks ...", file=sys.stderr)
    stock_out, stock_fail = _fetch_batch(stocks, "stock")
    # Backfill kind for the stock branch since fetch_one doesn't add it
    # (legacy ergonomic â€” the merge step downstream stamps it).
    for r in stock_out.values():
        r.setdefault("kind", "STOCK")

    print(f"Fetching ETFs ...", file=sys.stderr)
    etf_out, etf_fail = _fetch_batch(etfs, "etf")

    merged = {**stock_out, **etf_out}
    payload = {
        "generated_at_ms": int(time.time() * 1000),
        "source": "tickertape",
        "stocks": merged,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    total_failed = len(stock_fail) + len(etf_fail)
    print(f"\nWrote {len(merged)} entries to {out_path}", file=sys.stderr)
    print(f"  stocks: {len(stock_out)}/{len(stocks)} succeeded", file=sys.stderr)
    print(f"  etfs:   {len(etf_out)}/{len(etfs)} succeeded", file=sys.stderr)
    if total_failed:
        print(f"  ({total_failed} symbols had no Tickertape match â€” mostly delisted / suspended)", file=sys.stderr)


import os

if __name__ == "__main__":
    main()
