"""Numbers for the second and third batches of /learn guides, on top of build_learn_data.py.

    python scripts/build_learn_data_extra.py [--refresh]

Writes scripts/data/learn/<slug>.json. Closes come from the same cache as dipStats
(scripts/.dipcache). The full ^NSEI series from 2007 is fetched once from Yahoo and checked
against scripts/data/nifty50_closes.csv before anything is computed from it.
"""
import datetime as dt
import json
import statistics
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_dip_stats as bds  # noqa: E402
import build_learn_data as bl  # noqa: E402

ROOT = bl.ROOT
OUT = bl.OUT
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
REFRESH = "--refresh" in sys.argv


def nifty_full(upto):
    path = bds.CACHE / "idx_NSEI_full.json"
    if path.exists() and not REFRESH:
        rows = json.loads(path.read_text())
    else:
        a = int(dt.datetime(2007, 9, 1, tzinfo=dt.timezone.utc).timestamp())
        url = ("https://query1.finance.yahoo.com/v8/finance/chart/%%5ENSEI?period1=%d&period2=%d&interval=1d"
               % (a, int(time.time())))
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        res = json.load(urllib.request.urlopen(req, timeout=40))["chart"]["result"][0]
        q = res["indicators"]["quote"][0]
        rows = []
        for i, t in enumerate(res["timestamp"]):
            if q["close"][i]:
                rows.append((dt.datetime.fromtimestamp(t, IST).date().isoformat(), q["close"][i], q["volume"][i] or 0))
        path.write_text(json.dumps(rows))
    rows = [tuple(r) for r in rows if r[0] <= upto]
    have = {d: c for d, c, _ in rows}
    miss = bad = 0
    for d, c in bl.csv_closes():
        if d not in have:
            miss += 1
        elif abs(have[d] - c) > 0.6:
            bad += 1
    if bad:
        raise SystemExit("full Nifty series disagrees with nifty50_closes.csv on %d days" % bad)
    return rows, miss


def r2(x):
    return round(x, 2)


def stock(sym, upto):
    rows = bds.fetch(sym + ".NS")
    return [tuple(r) for r in rows if r[0] <= upto]


def nearest(rows, day):
    """Last close on or before day."""
    best = None
    for r in rows:
        if r[0] <= day:
            best = r
        else:
            break
    return best


def one_day_falls(rows):
    ch = []
    for i in range(1, len(rows)):
        ch.append((bl.pct(rows[i - 1][1], rows[i][1]), i))
    worst = sorted(ch)[:10]
    out = []
    for p, i in worst:
        back = next((j - i for j in range(i + 1, len(rows)) if rows[j][1] >= rows[i - 1][1]), None)
        out.append({"date": rows[i][0], "prev_close": r2(rows[i - 1][1]), "close": r2(rows[i][1]), "pct": p,
                    "next_day_pct": bl.pct(rows[i][1], rows[i + 1][1]) if i + 1 < len(rows) else None,
                    "sessions_to_regain": back})
    regained = [o["sessions_to_regain"] for o in out if o["sessions_to_regain"] is not None]
    return {"from": rows[0][0], "to": rows[-1][0], "sessions": len(rows), "top10": out,
            "days_down_3pct": sum(1 for p, _ in ch if p <= -3), "days_down_5pct": sum(1 for p, _ in ch if p <= -5),
            "pct_days_down_3pct": r2(100 * sum(1 for p, _ in ch if p <= -3) / len(ch)),
            "median_sessions_to_regain": statistics.median(regained), "regained": len(regained),
            "top10_in_2008": sum(1 for o in out if o["date"].startswith("2008")),
            "top10_in_2020": sum(1 for o in out if o["date"].startswith("2020"))}


def fall_tables(rows):
    idx = {r[0]: i for i, r in enumerate(rows)}
    f10, f20 = bl.falls(rows, 10), bl.falls(rows, 20)
    for f in f20 + f10:
        end = idx[f["recovered_date"]] if f["recovered_date"] else None
        f["peak_to_trough_sessions"] = idx[f["trough_date"]] - idx[f["peak_date"]]
        f["peak_to_recovery_sessions"] = (end - idx[f["peak_date"]]) if end else None
    corr = [f for f in f10 if f["depth_pct"] > -20]
    bear = [f for f in f10 if f["depth_pct"] <= -20]
    return {"from": rows[0][0], "to": rows[-1][0], "falls_10": f10, "falls_20": f20,
            "n_falls_10": len(f10), "n_corrections_10_to_20": len(corr), "n_20_or_more": len(bear),
            "median_depth_corrections": statistics.median([f["depth_pct"] for f in corr]),
            "median_peak_to_trough_corrections": statistics.median([f["peak_to_trough_sessions"] for f in corr]),
            "median_peak_to_recovery_corrections": statistics.median(
                [f["peak_to_recovery_sessions"] for f in corr if f["peak_to_recovery_sessions"]])}


def uni_syms(bit, uni):
    return [r["symbol"] for r in uni if r.get("kind") == "EQUITY" and (r.get("idx") or 0) & bit]


def events(uni, upto):
    """Run-ups as the FOMO detector defines them, and new 52-week highs and lows, across the Nifty 100."""
    fomo, base20, base60 = [], [], []
    hi, lo = [], []
    used = 0
    for s in uni_syms(2, uni):
        rows = stock(s, upto)
        if bds.quality(rows, s) not in (None, "stale") or len(rows) < 600:
            continue
        used += 1
        c = [r[1] for r in rows]
        last = -10 ** 9
        for i in range(70, len(c) - 60):
            rets = [c[j] / c[j - 1] - 1 for j in range(i - 59, i + 1)]
            vol = statistics.pstdev(rets)
            low = min(c[i - 10:i])
            run = c[i] / low - 1
            if run >= max(0.2, 3 * vol * 10 ** 0.5) and i - last >= 20:
                last = i
                fomo.append((c[i + 20] / c[i] - 1, c[i + 60] / c[i] - 1))
        for i in range(70, len(c) - 60, 20):
            base20.append(c[i + 20] / c[i] - 1)
            base60.append(c[i + 60] / c[i] - 1)
        lh = ll = -10 ** 9
        for i in range(250, len(c) - 250):
            w = c[i - 250:i]
            if c[i] > max(w) and i - lh >= 60:
                lh = i
                hi.append(c[i + 250] / c[i] - 1)
            if c[i] < min(w) and i - ll >= 60:
                ll = i
                lo.append(c[i + 250] / c[i] - 1)

    def summary(v):
        v = sorted(v)
        return {"n": len(v), "median_pct": r2(100 * statistics.median(v)),
                "pct_higher": r2(100 * sum(1 for x in v if x > 0) / len(v)),
                "p10_pct": r2(100 * v[len(v) // 10]), "p90_pct": r2(100 * v[len(v) * 9 // 10])}
    return used, {"after_runup_20": summary([a for a, _ in fomo]), "after_runup_60": summary([b for _, b in fomo]),
                  "all_days_20": summary(base20), "all_days_60": summary(base60)}, \
        {"after_new_high_250": summary(hi), "after_new_low_250": summary(lo)}


def near_high(uni, upto):
    gaps = []
    for s in uni_syms(1, uni):
        rows = stock(s, upto)
        if len(rows) < 260:
            continue
        w = [r[1] for r in rows[-250:]]
        gaps.append((bl.pct(max(w), w[-1]), s, r2(max(w)), r2(min(w)), r2(w[-1])))
    gaps.sort()
    v = [g[0] for g in gaps]
    return {"n": len(v), "median_below_high_pct": statistics.median(v),
            "n_within_5pct": sum(1 for x in v if x > -5), "n_20pct_or_more_below": sum(1 for x in v if x <= -20),
            "examples": [{"symbol": g[1], "high": g[2], "low": g[3], "close": g[4], "below_high_pct": g[0]}
                         for g in gaps if g[1] in ("RELIANCE", "TCS", "HDFCBANK", "INFY", "SBIN", "ITC")]}


def yes_bank(upto):
    rows = stock("YESBANK", upto)
    top = max((r for r in rows if r[0] < "2020-01-01"), key=lambda r: r[1])
    points = {}
    for label, day in (("before_moratorium", "2020-03-05"), ("moratorium_day", "2020-03-06"), ("rescue_1", "2020-03-16"),
                       ("rescue_2", "2020-03-17"), ("year_end_2019", "2019-12-31"), ("year_end_2018", "2018-12-31")):
        r = nearest(rows, day)
        points[label] = {"date": r[0], "close": r2(r[1]), "from_peak_pct": bl.pct(top[1], r[1])}
    low = min((r for r in rows if "2020-01-01" <= r[0]), key=lambda r: r[1])
    return {"peak": {"date": top[0], "close": r2(top[1])}, "points": points,
            "low_after": {"date": low[0], "close": r2(low[1]), "from_peak_pct": bl.pct(top[1], low[1])},
            "latest": {"date": rows[-1][0], "close": r2(rows[-1][1]), "from_peak_pct": bl.pct(top[1], rows[-1][1])},
            "one_day_moratorium_pct": bl.pct(nearest(rows, "2020-03-05")[1], nearest(rows, "2020-03-06")[1])}


def adani(uni, upto):
    names = {r["symbol"]: r["name"] for r in uni}
    out = []
    for s in ("ADANIENT", "ADANIPORTS", "ADANIPOWER", "ADANIGREEN", "ADANIENSOL"):
        rows = stock(s, upto)
        base = nearest(rows, "2023-01-24")
        w = [r for r in rows if "2023-01-25" <= r[0] <= "2023-12-31"]
        low = min(w, key=lambda r: r[1])
        back = next((r for r in rows if r[0] > low[0] and r[1] >= base[1]), None)
        fri = nearest(rows, "2023-01-27")
        out.append({"symbol": s, "name": names.get(s, s), "close_24jan": r2(base[1]),
                    "close_27jan": r2(fri[1]), "two_session_pct": bl.pct(base[1], fri[1]),
                    "low_date": low[0], "low_close": r2(low[1]), "low_pct": bl.pct(base[1], low[1]),
                    "back_above_date": back[0] if back else None,
                    "latest_date": rows[-1][0], "latest_close": r2(rows[-1][1]), "latest_pct": bl.pct(base[1], rows[-1][1])})
    return {"base_date": "2023-01-24", "stocks": out}


def best_days(rows):
    r = [(rows[i][0], rows[i][1] / rows[i - 1][1] - 1) for i in range(1, len(rows))]
    r = [x for x in r if x[0] >= "2011-01-03"]
    best = sorted(r, key=lambda x: -x[1])
    worst = sorted(r, key=lambda x: x[1])[:10]

    def grow(skip):
        v = 100000.0
        s = set(d for d, _ in skip)
        for d, x in r:
            if d not in s:
                v *= 1 + x
        return round(v)
    days = [d for d, _ in r]
    pos = {d: i for i, d in enumerate(days)}
    near = sum(1 for d, _ in best[:10] if any(abs(pos[d] - pos[w]) <= 10 for w, _ in worst))
    return {"from": r[0][0], "to": r[-1][0], "sessions": len(r), "all_days": grow([]), "miss_best_10": grow(best[:10]),
            "miss_best_20": grow(best[:20]), "miss_best_30": grow(best[:30]),
            "best10_within_10_sessions_of_worst10": near,
            "best_day": {"date": best[0][0], "pct": r2(100 * best[0][1])}}


def caps(uni):
    eq = sorted((r for r in uni if r.get("kind") == "EQUITY" and r.get("mc")), key=lambda r: -r["mc"])
    buckets = {}
    for r in uni:
        if r.get("kind") == "EQUITY":
            buckets[r.get("capBucket")] = buckets.get(r.get("capBucket"), 0) + 1
    total = sum(r["mc"] for r in eq)
    return {"n_with_market_cap": len(eq), "rank100_cr": eq[99]["mc"], "rank250_cr": eq[249]["mc"],
            "rank1_cr": eq[0]["mc"], "rank1": eq[0]["symbol"], "median_cr": eq[len(eq) // 2]["mc"],
            "share_top100_pct": r2(100 * sum(r["mc"] for r in eq[:100]) / total),
            "share_101_250_pct": r2(100 * sum(r["mc"] for r in eq[100:250]) / total),
            "share_rest_pct": r2(100 * sum(r["mc"] for r in eq[250:]) / total), "app_buckets": buckets}


def funds():
    rows = json.loads((ROOT / "js" / "data" / "mfFull.json").read_text(encoding="utf-8"))
    meta = json.loads((ROOT / "js" / "data" / "mfFull.meta.json").read_text(encoding="utf-8"))
    latest = max(r["nav_date"] for r in rows if r.get("nav_date"))
    cut = (dt.date.fromisoformat(latest) - dt.timedelta(days=14)).isoformat()
    active = [r for r in rows if (r.get("nav_date") or "") >= cut]

    def n(pred, src=active):
        return sum(1 for r in src if pred(r))

    def base_name(r):
        return r["name"].lower().split(" - ")[0]
    elss = [r for r in active if "elss" in (r.get("category") or "").lower()]
    return {"nav_date": latest, "rows_amfi": meta["row_count"], "active_rows": len(active), "amcs": meta["distinct_amcs"],
            "active_equity": n(lambda r: r.get("category_bucket") == "Equity"),
            "active_index": n(lambda r: r.get("category_bucket") == "Index"),
            "active_debt": n(lambda r: r.get("category_bucket") == "Debt"),
            "active_hybrid": n(lambda r: r.get("category_bucket") == "Hybrid"),
            "direct": n(lambda r: r.get("plan_type") == "Direct"), "regular": n(lambda r: r.get("plan_type") == "Regular"),
            "elss_rows": len(elss), "elss_schemes": len({base_name(r) for r in elss}),
            "elss_amcs": len({r["amc"] for r in elss}),
            "index_schemes": len({base_name(r) for r in active if r.get("category_bucket") == "Index"})}


def sip_through(rows, start, trough, end, monthly=5000):
    """A fixed monthly amount on each month's first session from start to end."""
    units = invested = 0.0
    month = None
    at_trough = None
    for d, c, _ in rows:
        if d < start or d > end:
            continue
        if d[:7] != month:
            month = d[:7]
            units += monthly / c
            invested += monthly
        if d == trough:
            at_trough = {"date": d, "invested": round(invested), "value": round(units * c),
                         "pct": bl.pct(invested, units * c)}
        last = (d, c)
    return {"monthly": monthly, "start": start, "at_trough": at_trough,
            "at_end": {"date": last[0], "invested": round(invested), "value": round(units * last[1]),
                       "pct": bl.pct(invested, units * last[1])}}


def sensex_2008():
    a = int(dt.datetime(2007, 9, 1, tzinfo=dt.timezone.utc).timestamp())
    b = int(dt.datetime(2011, 1, 1, tzinfo=dt.timezone.utc).timestamp())
    url = "https://query1.finance.yahoo.com/v8/finance/chart/%%5EBSESN?period1=%d&period2=%d&interval=1d" % (a, b)
    res = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=40))
    res = res["chart"]["result"][0]
    rows = [(dt.datetime.fromtimestamp(t, IST).date().isoformat(), c)
            for t, c in zip(res["timestamp"], res["indicators"]["quote"][0]["close"]) if c]
    y = [r for r in rows if r[0] <= "2008-12-31"]
    top = max(y, key=lambda r: r[1])
    low = min((r for r in y if r[0] > top[0]), key=lambda r: r[1])
    return {"peak": {"date": top[0], "close": r2(top[1])}, "trough": {"date": low[0], "close": r2(low[1])},
            "depth_pct": bl.pct(top[1], low[1])}


def first_salary():
    sip = json.loads((OUT / "sip-explained-nifty-backtest.json").read_text(encoding="utf-8"))
    return {"sip": sip}


def main():
    upto = bl.export("DIP_NOW")["NIFTY50"][3]
    rows, miss = nifty_full(upto)
    uni = json.loads((ROOT / "js" / "data" / "universeFull.json").read_text(encoding="utf-8"))
    used, fomo, hl = events(uni, upto)
    tables = fall_tables(rows)
    out = {
        "nifty-biggest-one-day-falls": one_day_falls(rows),
        "stock-market-crashes-india": tables,
        "what-is-a-market-correction": {k: tables[k] for k in tables if not k.startswith("falls_")},
        "fomo-investing": {"stocks": used, "universe": "Nifty 100 today, closes since 2011", "to": upto, **fomo},
        "52-week-high-anchoring": {"stocks": used, "to": upto, **hl, "nifty50_now": near_high(uni, upto)},
        "yes-bank-crash-2020": yes_bank(upto),
        "adani-hindenburg-2023-timeline": adani(uni, upto),
        "overtrading-churning": best_days(rows),
        "large-mid-small-cap-explained": caps(uni),
        "mutual-funds-stocks-etfs-explained": funds(),
        "crash-comparisons": {
            "covid_sip": sip_through(rows, "2020-01-14", "2020-03-23", "2020-11-09"),
            "gfc_sip": sip_through(rows, "2008-01-08", "2008-10-27", "2010-11-09"),
            "sensex_2008": sensex_2008(),
            "covid": next(f for f in tables["falls_20"] if f["peak_date"] == "2020-01-14"),
            "gfc": next(f for f in tables["falls_20"] if f["peak_date"] == "2008-01-08"),
        },
    }
    for slug, d in out.items():
        d = dict({"generated_by": "scripts/build_learn_data_extra.py"}, **d)
        (OUT / (slug + ".json")).write_text(json.dumps(d, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print("wrote %d files; Nifty %s to %s, %d sessions, %d csv days missing from Yahoo" % (len(out), rows[0][0], rows[-1][0], len(rows), miss))


if __name__ == "__main__":
    main()
