"""Generate js/data/dipStats.js: real dip-recovery statistics for every stock.

    python scripts/build_dip_stats.py            # all ~4,300 equities
    python scripts/build_dip_stats.py --refresh  # ignore the local price cache

For every equity in js/data/universeFull.json (NSE and SME as SYMBOL.NS,
BSE-only as SYMBOL.BO) this fetches daily closes since SINCE from Yahoo
Finance and measures, for each dip bucket X (5/7/10/15/20%):

- A dip starts on the first close at least X% below the running peak.
- It recovers on the first later close at or above that peak.
- recoveryDays = trading days from the dip start to the recovery close.
- After a recovery the peak tracking restarts from the recovery close, so one
  long fall counts once per bucket, not once per day.
- Dips that have not recovered yet are flagged (`open`), never folded into
  the median.

QUALITY GATE. Small and illiquid stocks often have bad Yahoo data (gaps,
prices frozen for months, unadjusted splits). A stock only gets its own
statistics, and its own indexable page, if all of these hold:
  - at least MIN_CLOSES daily closes (about three years),
  - a close within the last FRESH_DAYS days,
  - fewer than MAX_FLAT of the last year's closes unchanged from the day
    before, and the last 10 closes not all identical,
  - fewer than MAX_ZERO_VOL of the last year's sessions with zero volume,
  - no single-day move above MAX_JUMP (Indian circuit limits are 20%, so a
    bigger jump is almost always an unadjusted split, bonus or demerger),
  - at least MIN_RECOVERED recovered dips of 10% or more.
Everything else falls back to the Nifty 50 figures in the app. The reason
each stock failed is written to scripts/dip-quality.json.

Downloads are cached in scripts/.dipcache/ (gitignored) so a failed run can
resume. The whole run takes roughly 10-15 minutes.
"""
import concurrent.futures as cf
import datetime as dt
import json
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "js" / "data" / "dipStats.js"
REPORT = ROOT / "scripts" / "dip-quality.json"
CACHE = ROOT / "scripts" / ".dipcache"
SINCE = "2011-01-01"
BUCKETS = [5, 7, 10, 15, 20]
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))

MIN_CLOSES = 750
FRESH_DAYS = 14
MAX_FLAT = 0.25
MAX_ZERO_VOL = 0.20
MAX_JUMP = 0.45
MIN_RECOVERED = 3
WORKERS = 6


def ticker(r):
    return r["symbol"] + (".BO" if r.get("exchange") == "BSE" else ".NS")


def fetch(tk, refresh=False):
    """[(date, close, volume)] since SINCE, cached on disk. [] if Yahoo has none."""
    CACHE.mkdir(exist_ok=True)
    path = CACHE / (tk.replace("&", "_and_").replace("^", "idx_") + ".json")
    if path.exists() and not refresh:
        return json.loads(path.read_text())
    a = int(dt.datetime.fromisoformat(SINCE).replace(tzinfo=dt.timezone.utc).timestamp())
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/%s?period1=%d&period2=%d&interval=1d"
           % (urllib.parse.quote(tk), a, int(time.time())))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    res = None
    for attempt in range(6):
        try:
            res = json.load(urllib.request.urlopen(req, timeout=30))["chart"]["result"][0]
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                break
            time.sleep(4 * (attempt + 1))          # 429 / 5xx: back off
        except Exception:
            time.sleep(3 * (attempt + 1))
    rows = []
    if res:
        q = res["indicators"]["quote"][0]
        for i, t in enumerate(res.get("timestamp") or []):
            c = q["close"][i]
            if c:
                rows.append((dt.datetime.fromtimestamp(t, IST).date().isoformat(), c, q["volume"][i] or 0))
    path.write_text(json.dumps(rows))
    return rows


def dips(closes, pct):
    done, open_ = [], 0
    peak, start = None, None
    for i, c in enumerate(closes):
        if peak is None or (start is None and c > peak):
            peak = c
            continue
        if start is None:
            if c <= peak * (1 - pct / 100):
                start = i
        elif c >= peak:
            done.append(i - start)
            peak, start = c, None
    if start is not None:
        open_ = 1
    return done, open_


def stats(closes):
    out = {}
    for pct in BUCKETS:
        done, open_ = dips(closes, pct)
        if done:
            out[pct] = [int(round(statistics.median(done))), len(done), min(done), max(done), open_]
    return out


def quality(rows):
    """None if the series is usable, else the first reason it is not."""
    if len(rows) < MIN_CLOSES:
        return "short_history"
    last = dt.date.fromisoformat(rows[-1][0])
    if (dt.date.today() - last).days > FRESH_DAYS:
        return "stale"
    year = rows[-250:]
    closes = [c for _, c, _ in year]
    flat = sum(1 for a, b in zip(closes, closes[1:]) if a == b) / max(1, len(closes) - 1)
    if flat >= MAX_FLAT or len(set(closes[-10:])) == 1:
        return "frozen"
    if sum(1 for _, _, v in year if not v) / len(year) >= MAX_ZERO_VOL:
        return "illiquid"
    allc = [c for _, c, _ in rows]
    if any(abs(b / a - 1) > MAX_JUMP for a, b in zip(allc, allc[1:]) if a):
        return "bad_jump"
    return None


def main():
    refresh = "--refresh" in sys.argv
    universe = json.loads((ROOT / "js" / "data" / "universeFull.json").read_text(encoding="utf-8"))
    equities = [r for r in universe if r.get("kind") == "EQUITY"]
    data, since, reasons = {}, {}, {}

    def work(r):
        return r, fetch(ticker(r), refresh)

    t0 = time.time()
    with cf.ThreadPoolExecutor(WORKERS) as pool:
        for n, (r, rows) in enumerate(pool.map(work, equities), 1):
            sym = r["symbol"]
            why = "no_data" if not rows else quality(rows)
            if not why:
                st = stats([c for _, c, _ in rows])
                if st.get(10, [0, 0])[1] < MIN_RECOVERED:
                    why = "few_recoveries"
                else:
                    data[sym], since[sym] = st, rows[0][0]
            reasons[sym] = why or "ok"
            if n % 250 == 0:
                print("%5d/%d  %d qualified  %.0fs" % (n, len(equities), len(data), time.time() - t0), flush=True)

    nifty = fetch("^NSEI", refresh)
    composite = stats([c for _, c, _ in nifty])
    since["NIFTY50"] = nifty[0][0]

    counts = {}
    for v in reasons.values():
        counts[v] = counts.get(v, 0) + 1
    REPORT.write_text(json.dumps({"generated": dt.date.today().isoformat(), "counts": counts,
                                  "reasons": dict(sorted(reasons.items()))}, indent=1) + "\n")
    print("quality:", counts)

    body = (
        "// GENERATED by scripts/build_dip_stats.py on %s. Do not edit by hand.\n"
        "// Real dip-recovery statistics from Yahoo Finance daily closes since %s\n"
        "// (or since listing, see DIP_SINCE), for the %d stocks that pass the\n"
        "// script's data-quality gate. Per bucket (5/7/10/15/20%%):\n"
        "// [median recovery days, recovered dips, fastest, slowest, still-open flag].\n\n"
        "export const DIP_SINCE = %s;\n\n"
        "export const DIPS = %s;\n\n"
        "export const NIFTY_COMPOSITE = %s;\n"
        % (dt.date.today().isoformat(), SINCE, len(data),
           json.dumps(since, sort_keys=True, separators=(",", ":")),
           json.dumps(data, sort_keys=True, separators=(",", ":")),
           json.dumps(composite, separators=(",", ":")))
    )
    OUT.write_bytes(body.encode("utf-8"))
    print("wrote %s (%d KB)" % (OUT, len(body) // 1024))


if __name__ == "__main__":
    main()
