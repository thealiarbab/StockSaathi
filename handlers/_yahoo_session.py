"""Yahoo Finance authenticated session helper.

Yahoo's `/v7/finance/quote` and `/v10/finance/quoteSummary` endpoints require a
session cookie + a CSRF-style "crumb" since late 2024. Anonymous calls 401.
This module manages the (cookie, crumb) pair at module scope, refreshes on
401, and exposes a thin `fetch_with_crumb(url)` that handles retries.

Usage:
    from _yahoo_session import fetch_with_crumb
    data = fetch_with_crumb("https://query1.finance.yahoo.com/v10/finance/quoteSummary/RELIANCE.NS",
                            params={"modules": "summaryDetail,defaultKeyStatistics,assetProfile"})

Verified live 2026-04-25 — RELIANCE returns marketCap, trailingPE, priceToBook,
beta, dividendYield, sector, industry. No external deps.
"""

import json
import time
import urllib.request
import urllib.error
from urllib.parse import urlencode
from http.cookiejar import CookieJar

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

_HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
}

# Module-scoped session state. Refreshed on cold start and on 401.
_jar = None
_crumb = None
_warmed_at = 0
_SESSION_TTL_SEC = 60 * 60   # refresh hourly even without 401, just in case


def _build_opener(jar):
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(jar),
        urllib.request.HTTPRedirectHandler(),
    )


def _decompress_if_needed(resp_bytes, content_encoding):
    if content_encoding == "gzip":
        import gzip
        return gzip.decompress(resp_bytes)
    if content_encoding == "deflate":
        import zlib
        return zlib.decompress(resp_bytes)
    return resp_bytes


def _warm_session():
    """Fetch fc.yahoo.com (404 but sets cookies) + /v1/test/getcrumb to obtain
    a fresh (jar, crumb) pair. Idempotent — overwrites module-scope state."""
    global _jar, _crumb, _warmed_at
    jar = CookieJar()
    opener = _build_opener(jar)

    # Step 1: warm the cookie jar. fc.yahoo.com 404s but Set-Cookie still fires.
    # Some networks block fc.yahoo.com — fall back to the consent flow.
    for warmup_url in (
        "https://fc.yahoo.com/",
        "https://finance.yahoo.com/quote/RELIANCE.NS",
    ):
        try:
            req = urllib.request.Request(warmup_url, headers=_HEADERS)
            with opener.open(req, timeout=8) as r:
                r.read(1024)   # drain a little so Set-Cookie sticks
            if any(c.name in ("A1", "A3", "GUC") for c in jar):
                break
        except urllib.error.HTTPError as e:
            # 404 is expected on fc.yahoo.com; continue if cookies were set.
            if any(c.name in ("A1", "A3", "GUC") for c in jar):
                break
        except Exception:
            continue

    if not any(c.name in ("A1", "A3", "GUC") for c in jar):
        return False

    # Step 2: trade cookies for a crumb.
    try:
        req = urllib.request.Request(
            "https://query1.finance.yahoo.com/v1/test/getcrumb",
            headers=_HEADERS,
        )
        with opener.open(req, timeout=8) as r:
            crumb = r.read().decode("utf-8", errors="replace").strip()
        if not crumb or len(crumb) > 64 or "<" in crumb:
            return False
    except Exception:
        return False

    _jar = jar
    _crumb = crumb
    _warmed_at = time.time()
    return True


def get_crumb(force_refresh=False):
    """Returns the active crumb string, warming the session if needed.
    Returns None if warmup fails (e.g. Yahoo blocking the IP)."""
    global _crumb
    if force_refresh or _crumb is None or (time.time() - _warmed_at) > _SESSION_TTL_SEC:
        if not _warm_session():
            return None
    return _crumb


def fetch_with_crumb(url, params=None, timeout=10, retry_on_401=True):
    """GET `url` with the active session cookie + crumb appended as a query
    param. Returns parsed JSON, or None on failure. Auto-refreshes the
    session once on 401."""
    crumb = get_crumb()
    if not crumb:
        return None
    return _do_fetch(url, params, crumb, timeout, retry_on_401)


def _do_fetch(url, params, crumb, timeout, retry_on_401):
    global _jar, _crumb
    qs = dict(params or {})
    qs["crumb"] = crumb
    full_url = url + ("&" if "?" in url else "?") + urlencode(qs)
    opener = _build_opener(_jar) if _jar else _build_opener(CookieJar())
    try:
        req = urllib.request.Request(full_url, headers=_HEADERS)
        with opener.open(req, timeout=timeout) as r:
            body = _decompress_if_needed(r.read(), r.headers.get("Content-Encoding"))
        return json.loads(body.decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        if e.code == 401 and retry_on_401:
            # Crumb rotated — refresh once and retry.
            new_crumb = get_crumb(force_refresh=True)
            if new_crumb and new_crumb != crumb:
                return _do_fetch(url, params, new_crumb, timeout, retry_on_401=False)
        return None
    except Exception:
        return None
