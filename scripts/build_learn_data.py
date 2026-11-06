#!/usr/bin/env python3
"""Numbers for the /learn guides, from the same data the app uses.

    python scripts/build_learn_data.py            # cached Nifty closes
    python scripts/build_learn_data.py --refresh  # refetch ^NSEI first

Writes scripts/data/learn/<slug>.json. A guide's Key takeaways may only quote
a number that is declared in its front matter, and prerender.py checks every
"data:" fact against these files, so a guide can't drift from its data.

Cross-checks (the script stops if any fails):
- Nifty falls are measured with build_dip_stats.dips(), and the bucket stats
  must equal NIFTY_COMPOSITE in js/data/dipStats.js (what stock pages show).
- The crash paths use build_crash_frames.py's model (₹1,00,000 moving with the
  Nifty 50; the panic-seller sells at the trading-day-3 close) and must
  reproduce heldEnd/panicEnd in js/data/crashes.js.
- User statistics come only from scripts/data/public_stats.json
  (percentages and rankings, never counts).
"""

import datetime as dt
import json
import re
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import build_dip_stats as bds  # noqa: E402

OUT = ROOT / "scripts" / "data" / "learn"
DIPSTATS = (ROOT / "js" / "data" / "dipStats.js").read_text(encoding="utf-8")
CRASHES = (ROOT / "js" / "data" / "crashes.js").read_text(encoding="utf-8")


def export(name):
    m = re.search(r"^export const %s = (.*?);\s*$" % name, DIPSTATS, re.M | re.S)
    return json.loads(m.group(1))


def crash_num(cid, key):
    body = re.search(r"const %s = \{(.*?)\n\};" % cid, CRASHES, re.S).group(1)
    return float(re.search(r"\n\s*%s:\s*(-?[\d.]+)" % key, body).group(1))


def csv_closes():
    rows = []
    for line in (ROOT / "scripts" / "data" / "nifty50_closes.csv").read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#") and line[0].isdigit():
            d, c = line.split(",")
            rows.append((d, float(c)))
    return rows


def pct(a, b):
    return round((b / a - 1) * 100, 1)


def falls(rows, pct_):
    """Every fall of pct_% or more from a running peak, with its dates.

    Same state machine as build_dip_stats.dips(); asserted equal below.
    """
    out, peak_i, start = [], None, None
    for i, (_, c, _) in enumerate(rows):
        if peak_i is None or (start is None and c > rows[peak_i][1]):
            peak_i = i
            continue
        if start is None:
            if c <= rows[peak_i][1] * (1 - pct_ / 100):
                start = i
        elif c >= rows[peak_i][1]:
            out.append((peak_i, start, i))
            peak_i, start = i, None
    res = []
    for p, s, r in out + ([(peak_i, start, None)] if start is not None else []):
        seg = range(s, r if r is not None else len(rows))
        t = min(seg, key=lambda j: rows[j][1])
        res.append({
            "peak_date": rows[p][0], "peak_close": round(rows[p][1], 2),
            "start_date": rows[s][0], "trough_date": rows[t][0], "trough_close": round(rows[t][1], 2),
            "depth_pct": pct(rows[p][1], rows[t][1]),
            "recovered_date": rows[r][0] if r is not None else None,
            "recovery_days": (r - s) if r is not None else None,
            "open_days": None if r is not None else len(rows) - s,
        })
    return res


def crash(cid, start, end):
    """₹1,00,000 tracking the Nifty 50 from `start`; seller exits at day-3 close."""
    rows = csv_closes()
    dates = [d for d, _ in rows]
    i0, i1 = dates.index(start), dates.index(end)
    base = rows[i0][1]
    held = [100000 * c / base for _, c in rows[i0:i1 + 1]]
    sold_at = held[3]
    if (round(held[-1]), round(sold_at)) != (round(crash_num(cid, "heldEnd")), round(crash_num(cid, "panicEnd"))):
        raise SystemExit("%s: path does not reproduce crashes.js heldEnd/panicEnd" % cid)
    low = min(range(i0, i1 + 1), key=lambda j: rows[j][1])
    back = next((j for j in range(low, len(rows)) if rows[j][1] >= base), None)
    path = []
    for j in range(i0, i1 + 1):                       # first close of each month + key days
        d = rows[j][0]
        if j in (i0, i0 + 3, low, i1) or d[:7] != rows[j - 1][0][:7]:
            path.append({"date": d, "nifty": round(rows[j][1], 2), "held": round(100000 * rows[j][1] / base),
                         "sold": round(100000 * rows[j][1] / base) if j - i0 <= 3 else round(sold_at)})
    return {
        "start_date": start, "start_close": round(base, 2),
        "day3_date": rows[i0 + 3][0], "day3_close": round(rows[i0 + 3][1], 2), "sold_value": round(sold_at),
        "day3_drop_pct": pct(base, rows[i0 + 3][1]),
        "low_date": rows[low][0], "low_close": round(rows[low][1], 2), "low_held": round(100000 * rows[low][1] / base),
        "low_drop_pct": pct(base, rows[low][1]),
        "low_day_change_pct": pct(rows[low - 1][1], rows[low][1]),
        "low_calendar_days": (dt.date.fromisoformat(rows[low][0]) - dt.date.fromisoformat(start)).days,
        "end_date": end, "end_close": round(rows[i1][1], 2), "held_end": round(held[-1]), "panic_end": round(sold_at),
        "held_end_pct": pct(100000, held[-1]), "panic_end_pct": pct(100000, sold_at),
        "final_delta": crash_num(cid, "finalDelta"),
        "back_to_start_date": rows[back][0] if back is not None else None,
        "back_to_start_trading_days_from_low": (back - low) if back is not None else None,
        "year_after_low": next(({"date": rows[j][0], "nifty": round(rows[j][1], 2),
                                 "held": round(100000 * rows[j][1] / base)}
                                for j in range(low, len(rows)) if rows[j][0] >= str(int(rows[low][0][:4]) + 1) + rows[low][0][4:]),
                               None),
        "path": path,
    }


def main():
    # Stop at the date dipStats.js was built to, so guides match the stock pages.
    upto = export("DIP_NOW")["NIFTY50"][3]
    rows = [r for r in bds.fetch("^NSEI", "--refresh" in sys.argv) if r[0] <= upto]
    closes = [c for _, c, _ in rows]
    comp = export("NIFTY_COMPOSITE")
    mine, _ = bds.stats(rows)
    if {str(k): v for k, v in mine.items()} != comp:
        raise SystemExit("Nifty data differs from dipStats.js NIFTY_COMPOSITE: run with --refresh, or rebuild "
                         "dipStats first.\n mine %s\n site %s" % (mine, comp))
    if [f["recovery_days"] for f in falls(rows, 10) if f["recovered_date"]] != bds.dips(closes, 10)[0]:
        raise SystemExit("falls() disagrees with build_dip_stats.dips()")
    # The checks above prove the series matches the site. dipStats starts on
    # 3 Jan 2011, mid-fall, which splits one long fall in two (a false 48-day
    # recovery in 2013). Guides measure from the real record high instead.
    start_high = "2010-11-09"
    rows = [(d, c, 0) for d, c in csv_closes() if start_high <= d < rows[0][0]] + rows
    closes = [c for _, c, _ in rows]
    comp = {str(k): v for k, v in bds.stats(rows)[0].items()}
    f10 = falls(rows, 10)
    now = export("DIP_NOW")["NIFTY50"]
    data_to = rows[-1][0]
    stats = json.loads((ROOT / "scripts" / "data" / "public_stats.json").read_text(encoding="utf-8"))

    def bucket(p):
        med, n, fast, slow, open_days = comp[str(p)]
        return {"median_days": med, "recovered": n, "fastest_days": fast, "slowest_days": slow,
                "open_days": open_days}

    out = {}
    out["nifty-recovery-time"] = {
        "since": rows[0][0], "data_to": data_to,
        "buckets": {str(p): bucket(p) for p in bds.BUCKETS},
        "falls10": f10, "falls20": falls(rows, 20), "falls30": falls(rows, 30),
        "n_falls10": len(f10), "n_open10": sum(1 for f in f10 if not f["recovered_date"]),
        "n_falls20": len(falls(rows, 20)), "n_falls30": len(falls(rows, 30)),
        "now": {"high": now[0], "high_date": now[1], "last": now[2], "last_date": now[3],
                "below_high_pct": pct(now[0], now[2]), "open10_since": now[4]},
    }
    out["covid-crash-2020-nifty"] = crash("COVID_2020", "2020-02-19", "2020-11-09")
    out["2008-crash-india"] = dict(crash("GFC_2008", "2008-01-08", "2008-10-27"),
                                   nifty_buckets={"20": bucket(20), "10": bucket(10)})
    years = {}
    for d, c, _ in rows:
        years[d[:4]] = (d, c)
    ys = sorted(years)
    out["nifty-sensex-explained"] = {
        "data_to": data_to,
        "year_end": [{"year": y, "date": years[y][0], "close": round(years[y][1], 2),
                      "change_pct": pct(years[ys[i - 1]][1], years[y][1]) if i else None}
                     for i, y in enumerate(ys)],
        "first_close": {"date": rows[0][0], "close": round(rows[0][1], 2)},
        "last_close": {"date": data_to, "close": round(rows[-1][1], 2)},
        "since_start_pct": pct(rows[0][1], rows[-1][1]),
        "full_years": len(ys) - 2,                       # first and current year are partial
        "full_years_up": sum(1 for i, y in enumerate(ys[1:-1], 1) if years[y][1] > years[ys[i - 1]][1]),
        "first_year_pct": pct(rows[0][1], years[ys[0]][1]),
    }
    fb = stats["first_buys"]
    out["what-students-buy-first"] = {
        "generated_at": stats["generated_at"], "period": stats["period"],
        "top": [t for t in fb["top"] if not t["list_order_artifact"]][:8],
        "pct_first_buy_nifty50": fb["pct_first_buy_nifty50"], "pct_first_buy_etf": fb["pct_first_buy_etf"],
        "pct_first_buy_reliance": fb["pct_first_buy_reliance"],
        "sectors": stats["sectors_by_trades"]["top"][:6],
        "pct_trades_in_nifty50": stats["pct_trades_in_nifty50"],
    }
    out["panic-selling"] = {
        "generated_at": stats["generated_at"], "panic": stats["panic_pattern"],
        "nifty10": bucket(10), "nifty20": bucket(20),
    }
    out["share-market-kaise-sikhe"] = {
        "pct_first_buy_nifty50": fb["pct_first_buy_nifty50"],
        "pct_replay_starters_who_finished": stats["activity"]["pct_replay_starters_who_finished"],
        "pct_traders_used_limit_or_amo": stats["activity"]["pct_traders_used_limit_or_amo"],
        "nifty10": bucket(10),
    }
    out["market-limit-amo-orders"] = {
        "pct_traders_used_limit_or_amo": stats["activity"]["pct_traders_used_limit_or_amo"],
    }

    # ── wave 2 and 3 ───────────────────────────────────────────────────────
    out["demonetisation-stock-market"] = crash("DEMO_2016", "2016-11-08", "2017-02-28")

    # What happened after the Nifty first closed 10% below a high: how much
    # further it fell before turning, for each completed fall.
    further = []
    for f in f10:
        further.append({"start_date": f["start_date"], "depth_pct": f["depth_pct"],
                        "further_pct": round(abs(f["depth_pct"]) - 10, 1),
                        "recovered_date": f["recovered_date"], "recovery_days": f["recovery_days"]})
    done = [x for x in further if x["recovered_date"]]
    out["stock-market-crash-what-to-do"] = {
        "data_to": data_to, "falls": further, "n_falls10": len(f10), "n_recovered": len(done),
        "median_further_pct": round(statistics.median(x["further_pct"] for x in done), 1),
        "n_stopped_before_15": sum(1 for x in done if abs(x["depth_pct"]) < 15),
        "n_reached_20": sum(1 for x in further if abs(x["depth_pct"]) >= 20),
        "buckets": {"10": bucket(10), "20": bucket(20)},
        "now": out["nifty-recovery-time"]["now"],
    }

    # SIP: the same rupee amount on the first trading day of every month.
    sip_from, amount = "2015-01", 5000
    units = invested = 0.0
    flows, seen, path = [], set(), []
    for d, c, _ in rows:
        if d[:7] < sip_from or d[:7] in seen:
            continue
        seen.add(d[:7])
        units += amount / c
        invested += amount
        flows.append((dt.date.fromisoformat(d), -amount))
        if d[5:7] == "01":
            path.append({"date": d, "invested": round(invested), "value": round(units * c)})
    last_d, last_c = dt.date.fromisoformat(data_to), rows[-1][1]
    value = units * last_c
    lump = amount * len(seen) * last_c / next(c for d, c, _ in rows if d[:7] == sip_from)

    def xirr(cash):
        lo, hi = -0.9, 1.0
        for _ in range(100):
            r = (lo + hi) / 2
            npv = sum(a / (1 + r) ** ((d - cash[0][0]).days / 365) for d, a in cash)
            lo, hi = (r, hi) if npv > 0 else (lo, r)
        return r

    out["sip-explained-nifty-backtest"] = {
        "from": sip_from, "data_to": data_to, "monthly": amount, "months": len(seen), "invested": round(invested),
        "value": round(value), "gain_pct": pct(invested, value),
        "xirr_pct": round(xirr(flows + [(last_d, value)]) * 100, 1), "lump_sum_same_total_on_day_one": round(lump),
        "path": path + [{"date": data_to, "invested": round(invested), "value": round(value)}],
    }

    uni = json.loads((ROOT / "js" / "data" / "universeFull.json").read_text(encoding="utf-8"))
    dips_all, now_all = export("DIPS"), export("DIP_NOW")
    names = {r["symbol"]: r["name"] for r in uni}

    def in_index(bit):
        return [r["symbol"] for r in uni if r.get("kind") == "EQUITY" and (r.get("idx") or 0) & bit]

    fast = sorted(((dips_all[s]["10"][0], dips_all[s]["10"][1], s) for s in in_index(2)
                   if s in dips_all and dips_all[s].get("10") and dips_all[s]["10"][0] is not None
                   and dips_all[s]["10"][1] >= 5))
    out["fastest-recovering-large-caps"] = {
        "dip_data_on": re.search(r"on (\d{4}-\d{2}-\d{2})", DIPSTATS).group(1), "universe": "Nifty 100, 5+ recovered 10% falls",
        "n_stocks": len(fast), "median_of_medians": statistics.median(m for m, _, _ in fast),
        "nifty_median": comp["10"][0],
        "fastest": [{"symbol": s, "name": names[s], "median_days": m, "recovered": n} for m, n, s in fast[:10]],
        "slowest": [{"symbol": s, "name": names[s], "median_days": m, "recovered": n} for m, n, s in fast[-5:]],
    }

    below = []
    for s in in_index(4):
        n = now_all.get(s)
        if n and n[0] and n[2]:
            below.append({"symbol": s, "name": names[s], "high": n[0], "high_date": n[1], "last": n[2],
                          "below_pct": pct(n[0], n[2])})
    below.sort(key=lambda x: x["below_pct"])
    deep = lambda p: round(100 * sum(1 for b in below if b["below_pct"] <= -p) / len(below), 1)
    out["stocks-that-never-recovered"] = {
        "dip_data_on": re.search(r"on (\d{4}-\d{2}-\d{2})", DIPSTATS).group(1), "n_stocks": len(below),
        "pct_below_high_10": deep(10), "pct_below_high_30": deep(30), "pct_below_high_50": deep(50),
        "pct_below_high_75": deep(75), "median_below_pct": statistics.median(b["below_pct"] for b in below),
        "nifty_below_pct": out["nifty-recovery-time"]["now"]["below_high_pct"], "deepest": below[:12],
    }
    out["concentration-risk"] = {k: out["stocks-that-never-recovered"][k] for k in
                                 ("dip_data_on", "n_stocks", "pct_below_high_30", "pct_below_high_50",
                                  "median_below_pct", "nifty_below_pct")}

    eq = [r for r in uni if r.get("kind") == "EQUITY"]
    by_ex = {}
    for r in eq:
        by_ex[r.get("exchange")] = by_ex.get(r.get("exchange"), 0) + 1
    out["nse-and-bse-explained"] = {
        "nse_mainboard": by_ex.get("NSE", 0), "nse_sme": by_ex.get("NSE_SME", 0), "bse_only": by_ex.get("BSE", 0),
        "total_stocks": len(eq), "etfs": sum(1 for r in uni if r.get("kind") == "ETF"),
        "nse_with_bse_code": sum(1 for r in eq if r.get("exchange") == "NSE" and r.get("bseScripCd")),
    }

    OUT.mkdir(parents=True, exist_ok=True)
    for slug, d in out.items():
        d = dict({"generated_by": "scripts/build_learn_data.py"}, **d)
        (OUT / (slug + ".json")).write_text(json.dumps(d, indent=1, ensure_ascii=False) + "\n", encoding="utf-8",
                                            newline="\n")
    print("wrote %d files to %s (Nifty data to %s, %d falls of 10%%+)" % (len(out), OUT.relative_to(ROOT), data_to,
                                                                          len(f10)))


if __name__ == "__main__":
    main()
