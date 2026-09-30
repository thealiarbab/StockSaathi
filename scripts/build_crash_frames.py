"""Print frame data for the three curated crash replays from real closes.

    python scripts/build_crash_frames.py

Fetches daily Nifty 50 closes (Yahoo Finance ^NSEI) for each window and
prints, per scenario, the numbers that js/data/crashes.js needs: frames,
heldEnd, panicEnd, finalDelta, indexDrop and recoveryDays. The narrations in
crashes.js are written by hand around these numbers, so after changing a
window, re-run this and update both.

Model (same for all three scenarios, and stated on the replay pages):
- ₹1,00,000 that moves exactly with the Nifty 50 (no dividends, no costs).
- The panic-seller sells everything at the close of trading day 3 and stays
  in cash (no interest) until the end of the window.
- finalDelta = how far the winner finished ahead of the loser, in % of the
  loser's value: positive = holding won, negative = panic-selling won.
- recoveryDays = trading days from the lowest close to the first close back
  at or above the day-0 close (may fall after the window ends).
"""
import datetime as dt
import json
import urllib.parse
import urllib.request

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))

SCENARIOS = {
    # id: (start, end, fetch-until, frames: all days up to N, then every Kth)
    "COVID_2020": ("2020-02-19", "2020-11-09", "2021-01-31", 40, 3),
    "GFC_2008": ("2008-01-08", "2008-10-27", "2011-01-31", 16, 4),
    "DEMO_2016": ("2016-11-08", "2017-02-28", "2017-12-31", 999, 1),
}
# Days that carry a narration, so they must be frames (date -> narration id).
NARRATION_DAYS = {
    "COVID_2020": {
        "2020-02-19": "n_start", "2020-02-24": "n_day2", "2020-02-25": "n_sold",
        "2020-03-12": "n_pandemic", "2020-03-13": "n_circuitbreaker",
        "2020-03-23": "n_bottom", "2020-03-25": "n_bounce", "2020-05-18": "n_twomonths",
        "2020-08-31": "n_august", "2020-11-06": "n_recovered", "2020-11-09": "n_final",
    },
    "GFC_2008": {
        "2008-01-08": "n_gfc_start", "2008-01-11": "n_gfc_sold", "2008-01-22": "n_gfc_halt",
        "2008-03-17": "n_gfc_bear", "2008-09-15": "n_gfc_lehman", "2008-10-27": "n_gfc_bottom",
    },
    "DEMO_2016": {
        "2016-11-08": "n_demo_start", "2016-11-09": "n_demo_us", "2016-11-11": "n_demo_sold",
        "2016-11-21": "n_demo_queues", "2016-12-26": "n_demo_low",
        "2017-01-25": "n_demo_recovery", "2017-02-28": "n_demo_final",
    },
}


def closes(start, until):
    a = dt.datetime.fromisoformat(start).replace(tzinfo=dt.timezone.utc) - dt.timedelta(days=40)
    b = dt.datetime.fromisoformat(until).replace(tzinfo=dt.timezone.utc)
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/%s?period1=%d&period2=%d&interval=1d"
           % (urllib.parse.quote("^NSEI"), a.timestamp(), b.timestamp()))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    res = json.load(urllib.request.urlopen(req, timeout=30))["chart"]["result"][0]
    out = []
    for t, c in zip(res["timestamp"], res["indicators"]["quote"][0]["close"]):
        if c:
            out.append((dt.datetime.fromtimestamp(t, IST).date().isoformat(), round(c, 2)))
    return out


def build(cid):
    start, end, until, daily, step = SCENARIOS[cid]
    rows = closes(start, until)
    dates = [d for d, _ in rows]
    i0, i1 = dates.index(start), dates.index(end)
    win = rows[i0:i1 + 1]
    c0 = win[0][1]
    held = [100000 * c / c0 for _, c in win]
    sold_at = held[3]
    narr = NARRATION_DAYS[cid]
    for d in narr:
        assert d in dates[i0:i1 + 1], "%s: narration date %s is not a trading day in the window" % (cid, d)

    trough = min(range(len(win)), key=lambda i: win[i][1])
    keep = {0, 3, trough, len(win) - 1} | {i for i, (d, _) in enumerate(win) if d in narr}
    keep |= set(range(min(daily, len(win))))
    keep |= set(range(daily, len(win), step))

    lines = []
    for i in sorted(keep):
        d, c = win[i]
        panic = held[i] if i <= 3 else sold_at
        nid = narr.get(d)
        args = "%d, %s, %d, %d" % (i, ("%.2f" % c).rstrip("0").rstrip("."), round(held[i]), round(panic))
        lines.append("    frame(%s%s),  // %s" % (args, ', "%s"' % nid if nid else "", d))

    held_end, panic_end = round(held[-1]), round(sold_at)
    if held_end >= panic_end:
        delta = (held_end / panic_end - 1) * 100
    else:
        delta = -(panic_end / held_end - 1) * 100
    g0 = dates.index(win[trough][0])
    rec = next((j for j in range(g0, len(rows)) if rows[j][1] >= c0), None)
    print("// %s  %s -> %s  (%d trading days, %d frames)" % (cid, start, end, len(win) - 1, len(lines)))
    print("  finalDelta: %.1f," % delta)
    print("  heldEnd: %d," % held_end)
    print("  panicEnd: %d," % panic_end)
    print("  indexDrop: %.1f,   // lowest close %s on %s" % ((win[trough][1] / c0 - 1) * 100, win[trough][1], win[trough][0]))
    print("  recoveryDays: %s,  // back at/above %s on %s" % (rec - g0 if rec else "null", c0, rows[rec][0] if rec else "n/a"))
    print("  frames: [")
    print("\n".join(lines))
    print("  ],")
    for d in narr:
        i = dates.index(d) - i0
        prev = win[i - 1][1] if i else c0
        print("//   %s %s day %d: close %.2f, day %+.2f%%, from start %+.1f%%, held %d, panic %d"
              % (narr[d], d, i, win[i][1], (win[i][1] / prev - 1) * 100, (win[i][1] / c0 - 1) * 100,
                 round(held[i]), round(held[i] if i <= 3 else sold_at)))
    print()


if __name__ == "__main__":
    for cid in SCENARIOS:
        build(cid)
