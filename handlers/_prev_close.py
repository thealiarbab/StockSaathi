"""Previous close from the exchange's own end-of-day file.

WHY THIS EXISTS

Yahoo's 5-day chart sometimes leaves a whole session's bar empty (close =
None) and, for our IPs, omits meta.regularMarketPreviousClose. The fallback
then walks back to the last non-null bar, which is TWO sessions old. Measured
13 Oct 2026: the 12 Oct bar was null for 63MOONS, TCS and most of the market,
so 1,541 of 1,994 cached quotes carried Friday's close as "previous close" and
every "today %" was a two-day move (63MOONS +18.0% instead of +9.8%).

nse_eod_prices is ingested nightly from NSE's bhavcopy, so its latest row dated
before the price's own session is the official previous close. Yahoo's value
is only used when NSE has no row.
"""

import json
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

_IST = timezone(timedelta(hours=5, minutes=30))
# An NSE row further back than this from the price's session is not "the
# previous close" (suspension, long holiday gap in our data): keep Yahoo's.
_MAX_GAP_DAYS = 7


def _ist_date(ts_ms):
    ms = ts_ms or int(time.time() * 1000)
    return datetime.fromtimestamp(ms / 1000, tz=_IST).date()


def eod_prev_closes(quotes, timeout=2.5):
    """{symbol: prev_close_rupees} for quotes = {symbol: {"ts_ms": ...}}.

    One REST call. Returns {} on any failure, so callers keep their own value.
    """
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
           or os.environ.get("SUPABASE_ANON_KEY", "").strip())
    syms = [s for s in quotes if s and not s.startswith("MF_")]
    if not url or not key or not syms:
        return {}
    session = {s: _ist_date((quotes[s] or {}).get("ts_ms")) for s in syms}
    newest = max(session.values())
    oldest = min(session.values()) - timedelta(days=_MAX_GAP_DAYS + 3)
    inlist = ",".join('"%s"' % s.replace('"', "") for s in syms)
    q = ("/rest/v1/nse_eod_prices?select=symbol,trade_date,close_paise"
         "&symbol=in.(" + urllib.parse.quote(inlist, safe=",") + ")"
         "&trade_date=gte." + oldest.isoformat() +
         "&trade_date=lt." + newest.isoformat() +
         "&order=trade_date.desc&limit=" + str(len(syms) * 12))
    try:
        req = urllib.request.Request(url + q, headers={
            "apikey": key, "Authorization": "Bearer " + key})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            rows = json.loads(r.read())
    except Exception:
        return {}
    out = {}
    for row in rows if isinstance(rows, list) else []:
        s = row.get("symbol")
        if s not in session or s in out:
            continue
        try:
            d = datetime.strptime(row["trade_date"], "%Y-%m-%d").date()
        except Exception:
            continue
        # Rows are newest-first: the first one before this quote's session wins.
        if d >= session[s] or (session[s] - d).days > _MAX_GAP_DAYS:
            continue
        cp = row.get("close_paise") or 0
        if cp > 0:
            out[s] = cp / 100.0
    return out


def apply_eod_prev(quotes):
    """Overwrite prev_close / change_pct in place on fetched quote dicts."""
    live = {s: q for s, q in quotes.items() if q and q.get("price")}
    prevs = eod_prev_closes(live)
    for s, prev in prevs.items():
        q = live[s]
        q["prev_close"] = prev
        q["change_pct"] = (q["price"] - prev) / prev if prev else 0.0
    return quotes
