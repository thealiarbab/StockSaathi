"""Tickertape unofficial API wrapper.

Tickertape (tickertape.in) exposes a JSON API at api.tickertape.in that
returns rich fundamentals — market cap, PE (incl. trailing TTM), PB, beta,
dividend yield, EPS, 52-week range, plus industry PE/PB/divYield, ROE,
share count, and GIC sector classification. No auth needed.

Two-step flow per stock:
  1. /stocks/search?text=<NSE_SYMBOL>&types=stock → returns sid (e.g. "RELI")
  2. /stocks/info/<sid>?types=ratios → returns ratios block

The sid is stable per stock so we cache the (symbol → sid) mapping. For
Vercel cron (admin-sync-fundamentals) the sid map lives in Supabase
table `tickertape_sids`. For one-off live calls, an in-process LRU.

Verified live 2026-04-25 — ADFFOODS (sid AMRN) returns marketCap 2858.10,
pe 41.28, ttmPe 35.52, pb 5.80, beta 0.96, divYield 0.48, sector "Packaged
Foods & Meats", gic.sector "Consumer Staples". RELIANCE (sid RELI)
returns marketCap 1796850, pe 25.80, ttmPe 21.59, pb 1.78, beta 0.97.
"""

import json
import time
import urllib.request
import urllib.error
from urllib.parse import quote as urlquote

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

_HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive",
    "Origin": "https://www.tickertape.in",
    "Referer": "https://www.tickertape.in/",
}

# In-process sid cache. Cron writes to Supabase; this is the live-call backup.
_sid_cache = {}


def _http_get(url, timeout=8):
    try:
        req = urllib.request.Request(url, headers=_HEADERS)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", errors="replace"))
    except Exception:
        return None


def lookup_sid(nse_symbol):
    """Resolve NSE ticker → Tickertape sid. Cached in-process."""
    if not nse_symbol:
        return None
    if nse_symbol in _sid_cache:
        return _sid_cache[nse_symbol]

    url = (f"https://api.tickertape.in/stocks/search"
           f"?text={urlquote(nse_symbol)}&types=stock&pageNumber=0")
    payload = _http_get(url)
    if not payload or not payload.get("success"):
        return None
    results = (payload.get("data") or {}).get("searchResults") or []
    for r in results:
        info = (r.get("stock") or {}).get("info") or {}
        # Match exactly on NSE ticker — the search may return BSE-only names.
        if (info.get("ticker") or "").upper() == nse_symbol.upper() \
           and (info.get("exchange") or "").upper() == "NSE":
            sid = r.get("sid")
            if sid:
                _sid_cache[nse_symbol] = sid
                return sid
    # Fallback: first result if it's NSE-listed (loose match).
    for r in results:
        info = (r.get("stock") or {}).get("info") or {}
        if (info.get("exchange") or "").upper() == "NSE":
            sid = r.get("sid")
            if sid:
                _sid_cache[nse_symbol] = sid
                return sid
    return None


def fetch_ratios(nse_symbol, sid=None):
    """Fetch fundamentals from Tickertape for an NSE ticker. Returns a dict
    in the same shape as api/fundamentals.py expects, or None on failure.

    Pass `sid` if known (skips the search round-trip)."""
    if not sid:
        sid = lookup_sid(nse_symbol)
    if not sid:
        return None
    url = f"https://api.tickertape.in/stocks/info/{urlquote(sid)}?types=ratios"
    payload = _http_get(url)
    if not payload or not payload.get("success"):
        return None
    data = payload.get("data") or {}
    ratios = data.get("ratios") or {}
    info = data.get("info") or {}
    gic = data.get("gic") or {}

    if not ratios:
        return None

    # marketCap is in CRORES (per Tickertape convention) — convert to absolute INR.
    mcap_cr = ratios.get("marketCap")
    market_cap = float(mcap_cr) * 1e7 if mcap_cr is not None else None

    # Normalize divYield to match Yahoo's convention: decimal fraction
    # (0.0041 = 0.41%). Tickertape returns 0.41 = 0.41% directly, so divide
    # by 100 to align. Same for industry_dy + roe (Yahoo gives 0.07 = 7%).
    def _pct_to_frac(v):
        return float(v) / 100.0 if v is not None else None

    return {
        "name": info.get("name"),
        "sector_tickertape": info.get("sector"),         # e.g. "Oil & Gas - Refining & Marketing"
        "sector_gic": gic.get("sector"),                 # e.g. "Energy"
        "market_cap": market_cap,                        # absolute INR
        "market_cap_cr": mcap_cr,                        # crores
        "market_cap_label": ratios.get("marketCapLabel"),# e.g. "Largecap"
        "pe_ratio": ratios.get("pe"),
        "pe_ttm": ratios.get("ttmPe"),
        "pb_ratio": ratios.get("pb"),
        "beta": ratios.get("beta"),
        "dividend_yield": _pct_to_frac(ratios.get("divYield")),
        "eps": ratios.get("eps"),
        "roe": _pct_to_frac(ratios.get("roe")),
        "industry_pe": ratios.get("indpe"),
        "industry_pb": ratios.get("indpb"),
        "industry_dy": _pct_to_frac(ratios.get("inddy")),
        "fifty_two_week_high": ratios.get("52wHigh"),
        "fifty_two_week_low": ratios.get("52wLow"),
        "last_price": ratios.get("lastPrice"),
        "sid": sid,
        "source": "tickertape",
    }


def warm_sid_cache(symbol_sid_pairs):
    """Bulk-load the sid cache from a list of (symbol, sid) tuples. Used by
    the admin sync cron after reading from the Supabase tickertape_sids table."""
    for symbol, sid in symbol_sid_pairs:
        if symbol and sid:
            _sid_cache[symbol] = sid


def get_sid_cache():
    """Returns the in-process sid cache (for the cron to persist back to DB)."""
    return dict(_sid_cache)
