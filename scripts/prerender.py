#!/usr/bin/env python3
"""
Pre-render every public URL into a static HTML file (build-time SSR).

Why: the site is a client-rendered SPA. Crawlers that do not run JavaScript
(most AI crawlers, some search crawlers, every link-preview bot) only ever saw
the landing page. Each public URL now ships as its own HTML file with its own
<title>, description, canonical, Open Graph / Twitter tags, JSON-LD and real
content in <main>. Everyone gets the same bytes; the SPA then takes over
exactly as it already does on the pre-rendered landing page. No user-agent
detection anywhere, so there is nothing that could count as cloaking.

Template: index.html (after scripts/build_landing.py). Each page replaces the
<!-- meta:* --> head block and the <!-- landing:* --> block inside <main>.

Data: js/data/universeFull.json (stock facts) and js/data/crashes.js (replay
text) — the same files the app reads. Page copy for the hand-written pages
lives in partials/pages/*.html. Every claim must trace to docs/seo-plan.md §2.

Outputs (committed, served by Vercel with cleanUrls):
  index.html (head only)      /
  stocks.html                 /stocks
  stocks/<SYMBOL>.html        /stocks/<SYMBOL>   Nifty 500 only (thin-content guard)
  crash-replay.html           /crash-replay
  crash-replay/<ID>.html      /crash-replay/<ID> the three curated replays
  chat.html, news.html        /chat, /news (news is noindex: third-party headlines)
  learn-stock-market.html, for-students.html
  app-shell.html              noindex shell for gated / long-tail app routes
  404.html                    branded not-found page
  sitemap.xml, robots.txt, js/pageTitles.js

Usage:
  python scripts/prerender.py           write everything
  python scripts/prerender.py --check   exit 1 if anything on disk is stale
Stdlib only.
"""

import datetime as dt
import hashlib
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://stocksaathi.co.in"
STATE = ROOT / "scripts" / "prerender-state.json"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
TODAY = dt.datetime.now(IST).date().isoformat()

OG_IMAGE = SITE + "/images/og-image-v2.png"
OG_ALT = ("StockSaathi: Invest virtually. Learn for real. A free stock market simulator for Indian teens, beside "
          "a chart of the COVID-19 crash replay: ₹1,00,000 held finished at ₹1,02,764, sold on day 3 at ₹97,295.")
ROBOTS_INDEX = "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1"
ROBOTS_NOINDEX = "noindex, follow"

IDX_NAMES = [(1, "Nifty 50"), (2, "Nifty 100"), (4, "Nifty 500"), (8, "Nifty Midcap 150"), (16, "Nifty Smallcap 250")]

ORG_ID = SITE + "/#org"
SITE_ID = SITE + "/#website"
APP_ID = SITE + "/#app"
FOUNDER_ID = SITE + "/#founder"

e = html.escape


# ─── data ───────────────────────────────────────────────────────────────────

# Short connecting words lower-cased when an ALL-CAPS exchange name is title-cased.
SMALL_WORDS = {"AND": "and", "OF": "of", "THE": "the", "FOR": "for", "IN": "in"}


def clean_name(name):
    """Exchange names as people write them.

    BSE suffixes some names with "-$" (e.g. "Super Sales India Ltd-$") and
    some rows are ALL CAPS ("GMR AIRPORTS"). Words of up to three letters
    (GMR, ITC, NBCC-style initials) stay upper-case; longer ones are
    title-cased.
    """
    n = re.sub(r"\s*-\s*\$\s*$", "", name.strip())
    if n.upper() == n and re.search(r"[A-Z]{4,}", n):
        words = []
        for i, w in enumerate(n.split()):
            core = re.sub(r"[^A-Za-z]", "", w)
            if i and w in SMALL_WORDS:
                words.append(SMALL_WORDS[w])
            elif len(core) <= 3 or "&" in w or "." in w:
                words.append(w)
            else:
                words.append(w[:1] + w[1:].lower())
        n = " ".join(words)
    return n


def load_universe():
    rows = json.loads((ROOT / "js" / "data" / "universeFull.json").read_text(encoding="utf-8"))
    for r in rows:
        r["name"] = clean_name(r.get("name") or r["symbol"])
    equities = [r for r in rows if r.get("kind") == "EQUITY"]
    etfs = [r for r in rows if r.get("kind") == "ETF"]
    nifty500 = sorted((r for r in equities if (r.get("idx") or 0) & 4), key=lambda r: r["name"].lower())
    # A failed index-CSV fetch in the universe build leaves every idx at 0,
    # which would silently drop all stock pages from the site and sitemap.
    if len(nifty500) < 450:
        raise SystemExit("only %d Nifty 500 rows in universeFull.json; refusing to drop stock pages" % len(nifty500))
    check_claim_floors(equities, etfs)
    return equities, etfs, nifty500


# Rounded-down counts used in public copy (partials/, llms.txt, this file).
# The build fails if the data ever drops below one, so copy can't over-claim.
CLAIM_FLOORS = {"stocks": 4000, "etfs": 300, "active mutual funds": 8000}


def check_claim_floors(equities, etfs):
    mfs = json.loads((ROOT / "js" / "data" / "mfFull.json").read_text(encoding="utf-8"))
    cutoff = (dt.date.today() - dt.timedelta(days=365)).isoformat()
    # Same rule as _isMfTerminated() in js/pages/stocks.js.
    active = sum(1 for m in mfs if not ((isinstance(m.get("nav"), (int, float)) and m["nav"] < 0.01)
                                        or (m.get("nav_date") and m["nav_date"][:10] < cutoff)))
    have = {"stocks": len(equities), "etfs": len(etfs), "active mutual funds": active}
    HAVE.update(have)
    for k, floor in CLAIM_FLOORS.items():
        if have[k] < floor:
            raise SystemExit("copy claims %s+ %s but the data has %d; update the copy" % (format(floor, ","), k, have[k]))


HAVE = {}
# "4,000+ NSE and BSE stocks", "more than 8,000 active mutual fund schemes", "300+ ETFs"
COUNT_CLAIM = re.compile(r"(\d{1,3}(?:,\d{3})+|\d+)\+?\s+(?:NSE (?:and|&amp;|&) BSE |active |listed )?"
                         r"(stocks|ETFs|mutual fund)", re.I)
COUNT_KIND = {"stocks": "stocks", "etfs": "etfs", "mutual fund": "active mutual funds"}


def check_copy_counts(texts):
    """Every count claimed in public copy must be <= the real count.

    CLAIM_FLOORS only guards the data; the copy is typed by hand, so a
    "10,000+ mutual funds" would otherwise build cleanly (it did once).
    """
    for name, text in texts:
        for m in COUNT_CLAIM.finditer(text):
            claimed = int(m.group(1).replace(",", ""))
            kind = COUNT_KIND[m.group(2).lower()]
            if claimed >= 100 and claimed > HAVE[kind]:
                raise SystemExit("%s claims %s %s but the data has %d" % (name, m.group(1), kind, HAVE[kind]))


NIFTY_CSV = ROOT / "scripts" / "data" / "nifty50_closes.csv"


def nifty_closes():
    out = {}
    for line in NIFTY_CSV.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith(("#", "date")):
            d, c = line.split(",")
            out[d] = float(c)
    return out


NIFTY = nifty_closes()
# Rupee amounts a narration may mention that are not portfolio values.
NARRATION_RUPEES_OK = {100000, 1000, 500}


def check_crash(cid, body, n):
    """Refuse to publish a replay that contradicts real prices or itself.

    The first published versions sold the panic portfolio on day 3 for far
    less than it was worth that day (COVID: ₹66,800 against a ₹95,900
    portfolio), which flipped every headline result. Checks, all of which
    raise SystemExit (not assert, which python -O strips):
    - every frame's Nifty level equals the real close on its date
      (scripts/data/nifty50_closes.csv), one date per frame, days increasing;
    - held moves with the index, panic equals held up to day 3 and the day-3
      value after it;
    - heldEnd, panicEnd, finalDelta, indexDrop and recoveryDays match;
    - every rupee amount in a narration is a value the replay actually shows.
    """
    def fail(msg):
        raise SystemExit("crash replay %s: %s" % (cid, msg))

    frames = [(int(d), float(i), float(h), float(pn)) for d, i, h, pn in
              re.findall(r"frame\((\d+),\s*([\d.]+),\s*(\d+),\s*(\d+)", body)]
    dm = re.search(r"\n\s*dates:\s*\[([^\]]*)\]", body)
    dates = re.findall(r'"(\d{4}-\d{2}-\d{2})"', dm.group(1)) if dm else []
    if len(dates) != len(frames):
        fail("%d frames but %d dates" % (len(frames), len(dates)))
    days = [f[0] for f in frames]
    if days != sorted(set(days)) or days[0] != 0:
        fail("frame days must start at 0 and strictly increase")
    if dates != sorted(set(dates)):
        fail("dates must strictly increase")
    trading = sorted(d for d in NIFTY if dates[0] <= d <= dates[-1])
    for (day, idx, _, _), d in zip(frames, dates):
        if d not in NIFTY:
            fail("%s is not a trading day in nifty50_closes.csv" % d)
        if abs(NIFTY[d] - idx) > 0.01:
            fail("day %d (%s): Nifty %s, real close %s" % (day, d, idx, NIFTY[d]))
        if trading.index(d) != day:
            fail("%s is trading day %d of the window, frame says %d" % (d, trading.index(d), day))
    by_day = {d: (i, h, pn) for d, i, h, pn in frames}
    if 3 not in by_day:
        fail("no day-3 frame")
    base, sold = by_day[0][0], by_day[3][1]
    for day, (idx, held, panic) in by_day.items():
        if abs(held - 100000 * idx / base) > 1:
            fail("day %d: held %d not proportional to the index" % (day, held))
        want = held if day <= 3 else sold
        if abs(panic - want) > 1:
            fail("day %d: panic %d, expected %d" % (day, panic, want))
    last = by_day[max(by_day)]
    held_end, panic_end = n("heldEnd"), n("panicEnd")
    if abs(held_end - last[1]) > 1 or abs(panic_end - sold) > 1:
        fail("heldEnd/panicEnd != frames")
    delta = (held_end / panic_end - 1) * 100 if held_end >= panic_end else -(panic_end / held_end - 1) * 100
    if abs(delta - n("finalDelta")) >= 0.06:
        fail("finalDelta %s, frames say %.1f" % (n("finalDelta"), delta))
    window = [NIFTY[d] for d in trading]
    low_i = min(range(len(window)), key=window.__getitem__)
    drop = (window[low_i] / base - 1) * 100
    if abs(drop - n("indexDrop")) >= 0.06:
        fail("indexDrop %s, real closes say %.1f" % (n("indexDrop"), drop))
    after = sorted(d for d in NIFTY if d > trading[low_i])
    back = next((k + 1 for k, d in enumerate(after) if NIFTY[d] >= base), None)
    if back is None or back != n("recoveryDays"):
        fail("recoveryDays %s, real closes say %s" % (n("recoveryDays"), back))
    shown = {int(round(v)) for f in frames for v in (f[2], f[3])} | {int(held_end), int(panic_end)}
    narr = re.search(r"narrations:\s*\{(.*?)\n\s*\},", body, re.S).group(1)
    for amt in re.findall(r"₹([\d,]+)", narr):
        v = int(amt.replace(",", ""))
        if v not in NARRATION_RUPEES_OK and not any(abs(v - x) <= 1 for x in shown):
            fail("narration mentions ₹%s, which no frame shows" % amt)


def load_crashes():
    """Pull the three curated scenarios out of js/data/crashes.js."""
    src = (ROOT / "js" / "data" / "crashes.js").read_text(encoding="utf-8")
    out = []
    for cid in re.findall(r"export const CRASHES = \[([^\]]+)\]", src)[0].replace(" ", "").split(","):
        m = re.search(r"const %s = \{(.*?)\n\};" % cid, src, re.S)
        body = m.group(1)

        def s(key):
            mm = re.search(r'\n\s*%s:\s*"((?:[^"\\]|\\.)*)"' % key, body)
            return mm.group(1).replace('\\"', '"') if mm else ""

        def n(key):
            mm = re.search(r"\n\s*%s:\s*(-?[\d.]+)" % key, body)
            return float(mm.group(1)) if mm else None

        narr_block = re.search(r"narrations:\s*\{(.*?)\n\s*\},", body, re.S).group(1)
        narr = dict(re.findall(r'(\w+):\s*"((?:[^"\\]|\\.)*)"', narr_block))
        order = re.findall(r"frame\((\d+),[^)]*?\"(\w+)\"\)", body)
        timeline = [(int(day), narr[key].replace('\\"', '"')) for day, key in order if key in narr]
        check_crash(cid, body, n)
        out.append({
            "id": cid, "title": s("title"), "subtitle": s("subtitle"), "description": s("description"),
            "start": s("startLabel"), "end": s("endLabel"), "finalDelta": n("finalDelta"),
            "heldEnd": n("heldEnd"), "panicEnd": n("panicEnd"), "indexDrop": n("indexDrop"),
            "recoveryDays": n("recoveryDays"), "timeline": timeline,
        })
    return out


def rupees(v):
    v = int(round(v))
    s = str(v)
    if len(s) <= 3:
        return "₹" + s
    head, tail = s[:-3], s[-3:]
    parts = []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    return "₹" + ",".join(parts + [tail])


def indices(r):
    return [name for bit, name in IDX_NAMES if (r.get("idx") or 0) & bit]


def exch_label(r):
    return {"BSE": "BSE", "NSE_SME": "NSE SME"}.get(r.get("exchange"), "NSE")


def sector_rank(r):
    idx = r.get("idx") or 0
    return (not idx & 1, not idx & 2, not idx & 4, not idx & 8, r["name"].lower())


def stock_path(sym):
    return "/stocks/" + sym


def short_name(name):
    """'Reliance Industries Limited' -> 'Reliance Industries' for titles."""
    return re.sub(r"[\s,]+(Limited|Ltd\.?)$", "", name.strip(), flags=re.I)


def stock_title(name, sym, limit=60):
    """Longest honest title that fits in a search result (60 characters).

    Keeps "Paper Trading" and the brand; drops trailing words of a long
    company name instead ("Deepak Fertilizers (DEEPAKFERT) Paper Trading").
    """
    n = short_name(name)
    for t in ("%s (%s) Paper Trading Simulator | StockSaathi", "%s (%s) Paper Trading | StockSaathi"):
        title = t % (n, sym)
        if len(title) <= limit:
            return title
    words = n.split()
    while len(words) > 1:
        words.pop()
        while words and words[-1].lower() in ("and", "of", "the", "&", "for", "in"):
            words.pop()
        title = "%s (%s) Paper Trading | StockSaathi" % (" ".join(words), sym)
        if len(title) <= limit:
            return title
    return ("%s (%s) Paper Trading" % (n, sym))[:limit]


def load_dips():
    """Real dip-recovery stats written by scripts/build_dip_stats.py."""
    src = (ROOT / "js" / "data" / "dipStats.js").read_text(encoding="utf-8")

    def obj(name):
        m = re.search(r"export const %s = (\{.*?\});" % name, src, re.S)
        return json.loads(m.group(1))
    # Pages quote "on <date> X closed at ..." from this file, so it must keep
    # moving (.github/workflows/dip-stats.yml, weekly).
    built = re.search(r"GENERATED by scripts/build_dip_stats.py on (\d{4}-\d{2}-\d{2})", src)
    age = (dt.date.today() - dt.date.fromisoformat(built.group(1))).days if built else 999
    if age > 45:
        raise SystemExit("js/data/dipStats.js is %d days old; run scripts/build_dip_stats.py" % age)
    if age > 10:
        print("::warning::js/data/dipStats.js is %d days old (weekly dip-stats workflow failing?)" % age)
    return obj("DIPS"), obj("DIP_SINCE"), obj("DIP_NOW")


DIPS, DIP_SINCE, DIP_NOW = load_dips()
MIN_RECOVERED = 3      # same as scripts/build_dip_stats.py


def indexable_dips(sym):
    """Enough recovered 10% falls for a median: the page gets indexed."""
    row = DIPS.get(sym, {}).get("10")
    return bool(row) and row[1] >= MIN_RECOVERED


def inr(v):
    """1850.8 -> '₹1,850.80' with Indian digit grouping."""
    whole, frac = ("%.2f" % v).split(".")
    return rupees(int(whole)) + "." + frac


def human_date(iso):
    d = dt.date.fromisoformat(iso)
    return "%d %s %d" % (d.day, d.strftime("%b"), d.year)


def dip_html(sym, name):
    """This stock's real record of falls and recoveries, unrecovered ones included.

    The first version printed only the median of the falls that recovered.
    JUSTDIAL read "median recovery 12 trading days" while still 65% below its
    2014 high eight years later. Always say how many falls never recovered,
    and where the stock stands now.
    """
    row, now = DIPS.get(sym, {}).get("10"), DIP_NOW.get(sym)
    if not now:
        return ""
    since = DIP_SINCE.get(sym, "")[:4]
    peak, peak_date, last, last_date, open_start = now
    below = (1 - last / peak) * 100 if peak else 0
    paras = []
    if not row:
        paras.append("Since %s, %s has never closed 10%% or more below a previous high." % (since, e(name)))
    else:
        med, n, fast, slow, open_days = row
        falls = n + (1 if open_days else 0)
        s1 = ("Since %s, %s has fallen 10%% or more below a previous high %s." %
              (since, e(name), {1: "once", 2: "twice"}.get(falls, "%d times" % falls)))
        if n == 0:
            s2 = " It has not climbed back to that high yet."
        elif n == falls:
            s2 = (" It climbed back every time: the median recovery took %d trading days, the fastest %d "
                  "and the slowest %d." % (med, fast, slow)) if n > 1 else \
                 " It climbed back, after %s trading days." % format(med, ",")
        elif n == 1:
            s2 = " It climbed back once, after %s trading days." % format(med, ",")
        else:
            s2 = (" It climbed back %d of those times: the median recovery took %d trading days, the fastest %d "
                  "and the slowest %d." % (n, med, fast, slow))
        paras.append(s1 + s2)
        row20 = DIPS.get(sym, {}).get("20")
        if row20:
            f20 = row20[1] + (1 if row20[4] else 0)
            paras.append("Falls of 20%% or more: %s, %s." % (
                "one" if f20 == 1 else "%d" % f20,
                "not recovered yet" if row20[1] == 0 else
                ("recovered" if f20 == 1 else "all recovered") if row20[1] == f20 else
                "%d recovered" % row20[1]))
        if open_days:
            paras.append(
                "The latest fall began on %s and has not recovered after %s trading days: on %s %s closed at %s, "
                "%.1f%% below its highest close since %s (%s on %s)."
                % (human_date(open_start), format(open_days, ","), human_date(last_date), e(sym), inr(last), below, since,
                   inr(peak), human_date(peak_date)))
    if not row or not row[4]:
        if below < 0.5:
            paras.append("On %s it closed at %s, at or near its highest close since %s." %
                         (human_date(last_date), inr(last), since))
        else:
            paras.append("On %s it closed at %s, %.1f%% below its highest close since %s (%s on %s)." %
                         (human_date(last_date), inr(last), below, since, inr(peak), human_date(peak_date)))
    return """
  <h2>How %s has recovered from past falls</h2>
  <p>
    %s
  </p>
  <p>
    StockSaathi shows this record, unrecovered falls included, before a likely panic-sell. Daily closing prices
    from Yahoo Finance since %s. Past recoveries don't guarantee future ones.
  </p>""" % (e(sym), "\n    ".join(paras), since)


def stock_description(name, sym, limit=158):
    """Longest honest variant that fits in a search snippet."""
    for tail in (" A free stock market simulator for Indian teens.", " Free for Indian teens.", ""):
        d = "Practice trading %s (%s) shares with ₹1,00,000 of virtual money.%s" % (name, sym, tail)
        if len(d) <= limit:
            return d
    return d


# ─── JSON-LD ────────────────────────────────────────────────────────────────

def org_node():
    return {
        "@type": "Organization", "@id": ORG_ID, "name": "StockSaathi", "url": SITE + "/",
        "alternateName": ["Stock Saathi"],
        "slogan": "Invest virtually. Learn for real.",
        "logo": {"@type": "ImageObject", "url": SITE + "/images/logo-512.png", "width": 512, "height": 512},
        "description": "StockSaathi makes a free stock market simulator that teaches Indian teenagers to invest with virtual money.",
        "founder": {"@id": FOUNDER_ID},
        "areaServed": {"@type": "Country", "name": "India"},
        "sameAs": ["https://github.com/thealiarbab/StockSaathi"],
        "contactPoint": {"@type": "ContactPoint", "contactType": "customer support",
                         "email": "grievance@stocksaathi.co.in", "areaServed": "IN",
                         "availableLanguage": ["English"]},
    }


def founder_node():
    return {"@type": "Person", "@id": FOUNDER_ID, "name": "Ali Arbab",
            "sameAs": ["https://github.com/thealiarbab", "https://x.com/thealiarbab", "https://aliarbab2009.com"]}


def website_node():
    return {"@type": "WebSite", "@id": SITE_ID, "url": SITE + "/", "name": "StockSaathi",
            "inLanguage": "en-IN", "publisher": {"@id": ORG_ID}}


def app_node():
    return {
        "@type": "WebApplication", "@id": APP_ID, "name": "StockSaathi", "url": SITE + "/",
        "alternateName": ["Stock Saathi"],
        "applicationCategory": "FinanceApplication",
        "applicationSubCategory": "Stock market simulator and paper trading app",
        "operatingSystem": "Any (web browser)",
        "description": ("A free stock market simulator for Indian teens aged 13–18. Practise with ₹1,00,000 of virtual "
                        "money on real NSE and BSE stocks, ETFs and mutual funds at real market prices, with an AI coach "
                        "that flags beginner mistakes as you make them."),
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "INR"},
        "isAccessibleForFree": True,
        "inLanguage": "en-IN",
        "audience": {"@type": "PeopleAudience", "suggestedMinAge": 13, "suggestedMaxAge": 18,
                     "geographicArea": {"@type": "Country", "name": "India"}},
        "featureList": [
            "₹1,00,000 of virtual money",
            "4,000+ NSE and BSE stocks, 300+ ETFs and 8,000+ mutual funds at real market prices",
            "Market, limit and after-market orders",
            "AI coach that checks every trade for nine common investing mistakes",
            "Pause before a likely panic-sell showing how often that stock's past falls recovered, and which never did",
            "Replays of the 2020 COVID-19 crash, the 2008 financial crisis and 2016 demonetisation, built from real Nifty 50 closes",
            "Report card that grades decision quality from A+ to D",
            "Optional Hinglish mode",
        ],
        "screenshot": SITE + "/images/screenshot-wide.png",
        "publisher": {"@id": ORG_ID},
    }


def breadcrumb_node(url, crumbs):
    return {"@type": "BreadcrumbList", "@id": url + "#breadcrumb", "itemListElement": [
        {"@type": "ListItem", "position": i + 1, "name": name, "item": SITE + path}
        for i, (name, path) in enumerate(crumbs)]}


def webpage_node(page, extra=None):
    url = SITE + page["path"]
    node = {"@type": page.get("pageType", "WebPage"), "@id": url + "#webpage", "url": url,
            "name": page["title"], "description": page["description"], "inLanguage": "en-IN",
            "isPartOf": {"@id": SITE_ID}, "primaryImageOfPage": OG_IMAGE}
    if page.get("crumbs"):
        node["breadcrumb"] = {"@id": url + "#breadcrumb"}
    if extra:
        node.update(extra)
    return node


def faq_node(url, pairs):
    return {"@type": "FAQPage", "@id": url + "#faq", "mainEntity": [
        {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in pairs]}


def text_of(fragment):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", fragment))).strip()


def faq_pairs(markup):
    return [(text_of(q), text_of(a)) for q, a in
            re.findall(r'<div class="faq-item"[^>]*>\s*<h3>(.*?)</h3>\s*<p>(.*?)</p>\s*</div>', markup, re.S)]


# ─── head ───────────────────────────────────────────────────────────────────

def head(page):
    url = SITE + page["path"]
    robots = ROBOTS_INDEX if page.get("index", True) else ROBOTS_NOINDEX
    lines = [
        "<title>%s</title>" % e(page["title"]),
        '<meta name="description" content="%s" />' % e(page["description"]),
        '<meta name="robots" content="%s" />' % robots,
    ]
    if page.get("canonical", True):
        lines += [
            '<link rel="canonical" href="%s" />' % url,
            '<link rel="alternate" hreflang="en-IN" href="%s" />' % url,
            '<link rel="alternate" hreflang="x-default" href="%s" />' % url,
        ]
    og_type = page.get("ogType", "website")
    lines += [
        '<meta property="og:site_name" content="StockSaathi" />',
        '<meta property="og:locale" content="en_IN" />',
        '<meta property="og:type" content="%s" />' % og_type,
        '<meta property="og:title" content="%s" />' % e(page.get("ogTitle", page["title"])),
        '<meta property="og:description" content="%s" />' % e(page["description"]),
        '<meta property="og:url" content="%s" />' % url,
        '<meta property="og:image" content="%s" />' % OG_IMAGE,
        '<meta property="og:image:type" content="image/png" />',
        '<meta property="og:image:width" content="1200" />',
        '<meta property="og:image:height" content="630" />',
        '<meta property="og:image:alt" content="%s" />' % e(OG_ALT),
        '<meta name="twitter:card" content="summary_large_image" />',
        '<meta name="twitter:site" content="@thealiarbab" />',
        '<meta name="twitter:title" content="%s" />' % e(page.get("ogTitle", page["title"])),
        '<meta name="twitter:description" content="%s" />' % e(page["description"]),
        '<meta name="twitter:image" content="%s" />' % OG_IMAGE,
        '<meta name="twitter:image:alt" content="%s" />' % e(OG_ALT),
    ]
    graph = page.get("graph")
    if graph:
        ld = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False, indent=2)
        lines.append('<script type="application/ld+json">\n' + ld + "\n  </script>")
    return "\n".join("  " + ln for ln in lines)


# ─── page bodies ────────────────────────────────────────────────────────────

def crumbs_html(crumbs):
    parts = []
    for i, (name, path) in enumerate(crumbs):
        if i == len(crumbs) - 1:
            parts.append("<span>%s</span>" % e(name))
        else:
            parts.append('<a href="%s">%s</a>' % (path, e(name)))
    return '<nav class="crumbs" aria-label="Breadcrumb">%s</nav>' % ' <span aria-hidden="true">›</span> '.join(parts)


def stock_main(r, siblings):
    name, sym = r["name"], r["symbol"]
    # BSE-only rows carry a bseScripCd too, so only an NSE listing plus a scrip
    # code means both exchanges.
    listed = ("the NSE and BSE" if r.get("exchange") == "NSE" and r.get("bseScripCd")
              else "the " + exch_label(r))
    bse = (" (BSE scrip code %s)" % e(r["bseScripCd"])) if r.get("bseScripCd") else ""
    rows = [("Company", e(name)), ("%s symbol" % ("BSE" if r.get("exchange") == "BSE" else "NSE"), e(sym))]
    if r.get("bseScripCd"):
        rows.append(("BSE scrip code", e(r["bseScripCd"])))
    if r.get("isin"):
        rows.append(("ISIN", e(r["isin"])))
    sector = r.get("sector") or ""
    if sector and sector not in ("Other", "Unknown"):
        rows.append(("Sector", e(sector)))
    idx = indices(r)
    if idx:
        rows.append(("Index membership", e(", ".join(idx))))
    facts = "".join("<tr><th scope=\"row\">%s</th><td>%s</td></tr>" % kv for kv in rows)
    sib_title = ("Other %s stocks to practise with" % sector) if sector and sector not in ("Other", "Unknown") \
        else "More stocks to practise with"
    sib = "".join('<li><a href="%s">%s (%s)</a></li>' % (stock_path(s["symbol"]), e(s["name"]), e(s["symbol"]))
                  for s in siblings)
    return f"""<article class="container static-page">
  {crumbs_html([("Home", "/"), ("Markets", "/stocks"), (name, stock_path(sym))])}
  <h1 class="tight">Practice trading {e(name)} ({e(sym)}) with virtual money</h1>
  <p class="lede">
    {e(name)} is listed on {listed} under the symbol {e(sym)}{bse}. On StockSaathi you can buy and sell
    {e(name)} shares at real market prices using ₹1,00,000 of virtual money: a free way for Indian teens to
    learn how the stock market works without risking real money.
  </p>
  <h2>{e(name)} at a glance</h2>
  <div class="table-wrap"><table class="facts">{facts}</table></div>
  <h2>What you can do here</h2>
  <ul class="checklist">
    <li>See the price and a candlestick chart from one day to the full history.</li>
    <li>Place market, limit and after-market orders with virtual money.</li>
    <li>Add {e(sym)} to your watchlist and ask the AI coach about it.</li>
  </ul>
  <p>
    As you trade {e(sym)}, the coach watches for beginner mistakes: buying only after a big run-up,
    panic-selling after a sharp drop, or buying so much of one stock that it becomes more than 40% of your
    portfolio. It explains what it noticed in your own numbers and never tells you what to buy or sell.
  </p>{dip_html(sym, name)}
  <h2>{e(sib_title)}</h2>
  <ul class="link-list">{sib}</ul>
  <p class="fineprint">Prices and charts load in the app and can be delayed. StockSaathi is an educational simulator, not a
  SEBI-registered broker or adviser, and is not affiliated with NSE or BSE.</p>
</article>"""


def stocks_hub_main(equities, etfs, paged):
    n50 = [r for r in paged if (r.get("idx") or 0) & 1]
    by_sector = {}
    for r in paged:
        key = r.get("sector") if r.get("sector") not in (None, "", "Unknown") else "Other"
        by_sector.setdefault(key, []).append(r)
    order = sorted(by_sector, key=lambda k: (k == "Other", k.lower()))
    link = lambda r: '<li><a href="%s">%s <span class="dim">%s</span></a></li>' % (stock_path(r["symbol"]), e(r["name"]), e(r["symbol"]))
    sectors = "".join('<h3>%s</h3><ul class="link-list cols">%s</ul>' % (e(k), "".join(link(r) for r in by_sector[k]))
                      for k in order)
    return f"""<article class="container static-page">
  {crumbs_html([("Home", "/"), ("Markets", "/stocks")])}
  <h1 class="tight">Stock market simulator with 4,000+ NSE and BSE stocks</h1>
  <p class="lede">
    Practise trading real Indian stocks with ₹1,00,000 of virtual money. StockSaathi's markets cover more than
    4,000 stocks listed on the NSE and BSE, including NSE SME listings, plus 300+ ETFs and more than 8,000
    active mutual fund schemes, all at real market prices. Browsing is open to everyone; placing trades needs a free
    account.
  </p>
  <h2>How the markets page works</h2>
  <ul class="checklist">
    <li>Search by company name or symbol, or describe what you want in plain English, like "cheap IT stocks with low debt".</li>
    <li>Filter by sector, and switch between stocks and mutual funds.</li>
    <li>Open any stock for its price chart and to place market, limit or after-market orders.</li>
  </ul>
  <h2>Nifty 50 stocks</h2>
  <ul class="link-list cols">{"".join(link(r) for r in n50)}</ul>
  <h2>Stocks by sector</h2>
  {sectors}
  <p class="fineprint">StockSaathi is an educational simulator using virtual money. It is not a SEBI-registered
  broker or adviser and is not affiliated with NSE or BSE.</p>
</article>"""


def crash_hub_main(crashes):
    cards = ""
    for c in crashes:
        cards += f"""<section class="replay-summary">
    <h2><a href="/crash-replay/{c['id']}">{e(c['title'])}</a></h2>
    <p class="dim">{e(c['start'])} to {e(c['end'])}</p>
    <p>{e(c['description'])}</p>
  </section>
  """
    return f"""<article class="container static-page">
  {crumbs_html([("Home", "/"), ("Crash replays", "/crash-replay")])}
  <h1 class="tight">Stock market crash simulator: relive real Indian market crashes</h1>
  <p class="lede">
    Time Travel replays real market crashes day by day. Drag a slider through each one and watch the same
    ₹1,00,000 portfolio split in two: one investor who held, and one who panic-sold on day three. Each replay
    comes with narration of what was happening at the time. The three curated replays below need no account.
  </p>
  {cards}
  <h2>Featured replays and your own</h2>
  <p>
    Featured replays cover more of Indian market history: the Harshad Mehta scam of 1992, the dot-com crash of
    2000, the 2008 financial crisis, the Satyam scandal of 2009, the IL&amp;FS collapse of 2018, the DHFL crisis
    of 2019, the YES Bank moratorium and the COVID-19 crash of 2020, the Paytm IPO of 2021 and the
    Adani–Hindenburg report of 2023. They are built from real price data with AI-written narration, and you can
    type almost any other market event to generate a replay of your own.
  </p>
  <h2>Why replay a crash?</h2>
  <p>
    A crash is when beginners make their most expensive decision: selling near the bottom. Watching the held
    and panic-sold portfolios separate, and seeing the rare case where selling looked right for a while, is the
    closest thing to living through one without losing money. Your StockSaathi report card awards a Time
    Traveler badge for completing a replay.
  </p>
</article>"""


def crash_main(c, others):
    delta = c["finalDelta"]
    delta_line = ("Holding finished %.1f%% ahead of panic-selling." % delta) if delta >= 0 \
        else ("Within this window, the panic-seller finished %.1f%% ahead of holding." % abs(delta))
    stats = [
        ("Window", "%s to %s" % (c["start"], c["end"])),
        ("Index fall at its worst", "%.1f%%" % abs(c["indexDrop"])),
        ("Recovery", "%d trading days" % c["recoveryDays"] if c["recoveryDays"] else "within the plotted window"),
        ("Held portfolio at the end", rupees(c["heldEnd"])),
        ("Panic-sold on day 3", rupees(c["panicEnd"])),
    ]
    dl = "".join("<dt>%s</dt><dd>%s</dd>" % (e(k), e(v)) for k, v in stats)
    tl = "".join("<li><strong>Day %d.</strong> %s</li>" % (d, e(t)) for d, t in c["timeline"])
    other = "".join('<li><a href="/crash-replay/%s">%s</a> (%s)</li>' % (o["id"], e(o["title"]), e(o["subtitle"])) for o in others)
    return f"""<article class="container static-page">
  {crumbs_html([("Home", "/"), ("Crash replays", "/crash-replay"), (c["title"], "/crash-replay/" + c["id"])])}
  <h1 class="tight">{e(c['title'])} replay: hold or panic-sell?</h1>
  <p class="lede">
    {e(c['description'])} In this replay a ₹1,00,000 portfolio that moves with the Nifty 50 splits in two on
    day three: one investor holds, the other sells everything at that day's close and stays in cash.
    {e(delta_line)}
  </p>
  <p class="muted">Every step of the replay is a real daily closing level of the Nifty 50.</p>
  <dl class="stat-list">{dl}</dl>
  <h2>What happened, day by day</h2>
  <ol class="timeline">{tl}</ol>
  <h2>The lesson</h2>
  <p>
    Crashes feel endless from the inside, and the urge to sell is strongest near the bottom. Replaying one lets
    you feel that pressure with virtual money and see how the decision played out. StockSaathi's coach uses the
    same idea in live trading: before a likely panic-sell it shows how often that stock's past falls recovered,
    how long that took and which never did, then lets you decide.
  </p>
  <h2>More crash replays</h2>
  <ul class="link-list">{other}</ul>
  <p class="cta-line"><a href="/register" class="btn btn-primary btn-lg">Create a free account →</a>
  <a href="/learn-stock-market" class="btn btn-ghost btn-lg">Beginner's guide</a></p>
</article>"""


def chat_main():
    return f"""<article class="container static-page">
  {crumbs_html([("Home", "/"), ("AI coach", "/chat")])}
  <h1 class="tight">Ask Saathi: a free AI stock market coach for beginners</h1>
  <p class="lede">
    Saathi is StockSaathi's AI coach. Ask it anything about money, investing and Indian markets in plain
    English, or switch on Hinglish mode in Settings. It explains; it never gives tips. You can chat without an
    account, and once you have a portfolio it can talk you through your own trades.
  </p>
  <h2>Things you can ask</h2>
  <ul class="checklist">
    <li>"What's TCS at?" Current stock prices, looked up rather than guessed.</li>
    <li>"How does compounding work?" and "Explain P/E in one go."</li>
    <li>"Should I sell when the market crashes?" with what past crashes actually did.</li>
    <li>How Indian taxes on investing work, like short- and long-term capital gains.</li>
    <li>"How do I spot a finfluencer scam?"</li>
  </ul>
  <h2>What it won't do</h2>
  <p>
    Saathi won't tell you which stock to buy or sell and won't predict prices. It only talks about money:
    ask about anything else and it will politely decline. StockSaathi is an educational simulator, not a
    SEBI-registered adviser.
  </p>
</article>"""


def news_main():
    return f"""<article class="container static-page">
  {crumbs_html([("Home", "/"), ("News", "/news")])}
  <h1 class="tight">Indian stock market news, tagged by sentiment</h1>
  <p class="lede">
    A feed of Indian market headlines from major business news sources, each tagged bullish, bearish or neutral
    by a simple keyword scorer, so you can read the mood of the market before you practise a trade.
    Headlines link to the original publishers.
  </p>
</article>"""


def shell_main():
    return """<div class="empty-state" style="padding-top: var(--sp-12);">
  <div class="spinner" aria-hidden="true" style="margin: 0 auto var(--sp-4);"></div>
  <p class="dim" style="font-size: var(--text-sm);">One moment…</p>
</div>"""


def notfound_main():
    return """<div class="empty-state">
  <span class="emoji">🔍</span>
  <h1 style="font-size: var(--text-xl);">Page not found</h1>
  <p>The page you tried doesn't exist. Try one of these instead:</p>
  <p><a href="/" class="btn btn-primary">Home</a> <a href="/stocks" class="btn btn-ghost">Markets</a>
  <a href="/crash-replay" class="btn btn-ghost">Crash replays</a> <a href="/learn-stock-market" class="btn btn-ghost">Learn</a></p>
</div>"""


def partial(name, path):
    body = (ROOT / "partials" / "pages" / name).read_text(encoding="utf-8").strip()
    return body.replace('<article class="container static-page">',
                        '<article class="container static-page" data-static-page="%s">' % path, 1)


# ─── page registry ──────────────────────────────────────────────────────────

def build_pages():
    equities, etfs, nifty500 = load_universe()
    crashes = load_crashes()
    in500 = {r["symbol"] for r in nifty500}
    paged = sorted(nifty500 + [r for r in equities if indexable_dips(r["symbol"]) and r["symbol"] not in in500],
                   key=lambda r: r["name"].lower())
    pages = []

    def add(**p):
        p.setdefault("index", True)
        p.setdefault("sitemap", p["index"])
        url = SITE + p["path"]
        graph = [webpage_node(p, p.pop("webpageExtra", None))]
        if p.get("crumbs"):
            graph.append(breadcrumb_node(url, p["crumbs"]))
        graph += p.pop("extraGraph", [])
        p["graph"] = graph
        pages.append(p)

    # Home: head only (main comes from partials/landing.html via build_landing.py).
    home = {"path": "/", "file": "index.html", "headOnly": True, "priority": "1.0", "changefreq": "weekly",
            "title": "StockSaathi: Free Paper Trading & Stock Market Simulator for Teens",
            "description": ("Free paper trading app for Indian teens, 13–18. Practise with ₹1,00,000 of virtual "
                            "money on real NSE and BSE stocks, with an AI coach that spots mistakes."),
            "images": [(SITE + "/images/og-image-v2.png", OG_ALT),
                       (SITE + "/images/screenshot-wide.png", "The StockSaathi home page on a desktop screen"),
                       (SITE + "/images/screenshot-narrow.png", "The StockSaathi home page on a phone")],
            "graph": [website_node(), org_node(), founder_node(), app_node(),
                      {"@type": "WebPage", "@id": SITE + "/#webpage", "url": SITE + "/",
                       "name": "StockSaathi: Free Paper Trading & Stock Market Simulator for Teens", "inLanguage": "en-IN",
                       "isPartOf": {"@id": SITE_ID}, "about": {"@id": APP_ID}, "primaryImageOfPage": OG_IMAGE}],
            "index": True, "sitemap": True}
    pages.append(home)

    add(path="/stocks", file="stocks.html", priority="0.9", changefreq="weekly",
        title="Stock Market Simulator: 4,000+ NSE & BSE Stocks | StockSaathi",
        description=("Browse 4,000+ NSE and BSE stocks, ETFs and mutual funds, and practise trading them with virtual "
                     "money at real market prices. Free for Indian teens."),
        crumbs=[("Home", "/"), ("Markets", "/stocks")],
        main=stocks_hub_main(equities, etfs, paged))

    by_sector = {}
    for r in paged:
        by_sector.setdefault(r.get("sector") or "Other", []).append(r)
    for r in paged:
        group = by_sector[r.get("sector") or "Other"]
        i = group.index(r)
        # Four of the sector's biggest names (by index membership), then
        # alphabetical neighbours so every page still gets links from peers.
        big = sorted(group, key=sector_rank)
        sib = [s for s in big if s is not r][:4]
        sib += [s for s in (group[i + 1:] + group[:i]) if s is not r and s not in sib][:8 - len(sib)]
        if len(sib) < 4:                       # tiny sector: pad with alphabetical neighbours
            j = paged.index(r)
            sib += [s for s in paged[j + 1:j + 9] if s not in sib][:8 - len(sib)]
        sym, name = r["symbol"], r["name"]
        exch = "BSE" if r.get("exchange") == "BSE" else "NSE"
        corp = {"@type": "Corporation", "name": name, "tickerSymbol": "%s %s" % (exch, sym)}
        if r.get("isin"):
            corp["identifier"] = {"@type": "PropertyValue", "propertyID": "ISIN", "value": r["isin"]}
        # A stock page is indexable only when it carries real, stock-specific
        # figures: the dip-recovery history of a stock that passed the data-
        # quality gate in scripts/build_dip_stats.py. Nifty 500 stocks without
        # it keep a page for people (noindex, follow) but stay out of search.
        add(path=stock_path(sym), file="stocks/%s.html" % sym, priority="0.5", changefreq="monthly",
            index=indexable_dips(sym),
            title=stock_title(name, sym),
            ogTitle="Practice trading %s (%s) | StockSaathi" % (name, sym),
            description=stock_description(name, sym),
            crumbs=[("Home", "/"), ("Markets", "/stocks"), (name, stock_path(sym))],
            webpageExtra={"about": corp},
            main=stock_main(r, sib))

    add(path="/crash-replay", file="crash-replay.html", priority="0.9", changefreq="monthly",
        title="Stock Market Crash Simulator: Replay Indian Crashes | StockSaathi",
        description=("Relive the COVID-19 crash, the 2008 financial crisis and demonetisation day by day with a virtual "
                     "₹1,00,000 portfolio. See holding vs panic-selling. Free."),
        crumbs=[("Home", "/"), ("Crash replays", "/crash-replay")],
        main=crash_hub_main(crashes))

    for c in crashes:
        year = re.findall(r"(\d{4})", c["start"])[0]
        url = SITE + "/crash-replay/" + c["id"]
        lr = {"@type": "LearningResource", "@id": url + "#replay", "name": "%s replay" % c["title"],
              "description": c["description"], "learningResourceType": "Interactive simulation",
              "educationalLevel": "Beginner", "isAccessibleForFree": True, "inLanguage": "en-IN",
              "teaches": "How holding compares with panic-selling during a stock market crash",
              "audience": {"@type": "PeopleAudience", "suggestedMinAge": 13},
              "provider": {"@id": ORG_ID}, "url": url}
        add(path="/crash-replay/" + c["id"], file="crash-replay/%s.html" % c["id"], priority="0.8",
            changefreq="yearly",
            title="%s (%s) Replay: Hold or Panic-Sell? | StockSaathi" % (c["title"], year),
            description=("Replay the %s (%s) day by day with ₹1,00,000 of virtual money. The index fell %.0f%%. "
                         "See holding vs panic-selling. Free.") % (c["title"], year, abs(c["indexDrop"])),
            crumbs=[("Home", "/"), ("Crash replays", "/crash-replay"), (c["title"], "/crash-replay/" + c["id"])],
            extraGraph=[lr],
            main=crash_main(c, [o for o in crashes if o is not c]))

    add(path="/chat", file="chat.html", priority="0.7", changefreq="monthly",
        title="Ask Saathi: Free AI Stock Market Coach for Beginners | StockSaathi",
        description=("Ask StockSaathi's AI coach anything about investing and Indian markets in plain English or "
                     "Hinglish. It explains, never gives tips. Free, no account needed."),
        crumbs=[("Home", "/"), ("AI coach", "/chat")], main=chat_main())

    add(path="/news", file="news.html", index=False, priority="0.3", changefreq="daily",
        title="Indian Stock Market News with Sentiment | StockSaathi",
        description="Indian market headlines from major business news sources, tagged bullish, bearish or neutral.",
        crumbs=[("Home", "/"), ("News", "/news")], main=news_main())

    learn = partial("learn-stock-market.html", "/learn-stock-market")
    add(path="/learn-stock-market", file="learn-stock-market.html", priority="0.8", changefreq="monthly",
        pageType="Article", ogType="article",
        title="How to Learn the Stock Market as a Teenager in India",
        ogTitle="How to learn the stock market as a teenager in India, without real money",
        description=("A beginner's guide for Indian teens: key words, whether under-18s can invest, a free "
                     "practice portfolio with virtual money and nine mistakes to avoid."),
        crumbs=[("Home", "/"), ("Learn the stock market", "/learn-stock-market")],
        webpageExtra={"headline": "How to learn the stock market as a teenager in India, without real money",
                      "author": {"@id": ORG_ID}, "publisher": {"@id": ORG_ID},
                      "datePublished": "2026-09-30", "image": OG_IMAGE},
        extraGraph=[faq_node(SITE + "/learn-stock-market", faq_pairs(learn))],
        main=learn)

    add(path="/for-students", file="for-students.html", priority="0.8", changefreq="monthly",
        title="Stock Market Game for School Students in India | StockSaathi",
        description=("A free virtual stock market game for Indian students aged 13–18: ₹1,00,000 of virtual money, "
                     "real NSE and BSE stocks and an AI coach. No payments, no ads."),
        crumbs=[("Home", "/"), ("For students", "/for-students")],
        main=partial("for-students.html", "/for-students"))


    pages.append({"path": "/app-shell", "file": "app-shell.html", "index": False, "sitemap": False,
                  "canonical": False, "title": "StockSaathi",
                  "description": "StockSaathi, a free stock market simulator for Indian teens.",
                  "graph": None, "main": shell_main()})
    pages.append({"path": "/404", "file": "404.html", "index": False, "sitemap": False, "canonical": False,
                  "title": "Page not found | StockSaathi",
                  "description": "This page doesn't exist on StockSaathi.", "graph": None, "main": notfound_main()})
    # Static legal pages are hand-written files; they only join the sitemap.
    for path, pr in (("/privacy", "0.3"), ("/terms", "0.3"), ("/grievance", "0.3")):
        pages.append({"path": path, "file": path.lstrip("/") + ".html", "legal": True, "index": True,
                      "sitemap": True, "priority": pr, "changefreq": "yearly"})
    return pages


# ─── assembly ───────────────────────────────────────────────────────────────

def splice(doc, start, end, content):
    pat = re.compile(r"(" + re.escape(start) + r"\n)(.*?)(\n?[ \t]*" + re.escape(end) + r")", re.S)
    if not pat.search(doc):
        raise SystemExit("template markers %s not found" % start)
    return pat.sub(lambda m: m.group(1) + content.rstrip("\n") + m.group(3), doc, count=1)


def render(page, template):
    doc = splice(template, "<!-- meta:start -->", "<!-- meta:end -->", head(page))
    if page.get("headOnly"):
        return doc
    main = "\n".join("    " + ln if ln.strip() else "" for ln in page["main"].splitlines())
    doc = splice(doc, "<!-- landing:start -->", "<!-- landing:end -->", main)
    doc = splice(doc, "<!-- faq-jsonld:start -->", "<!-- faq-jsonld:end -->", "")
    return doc


def sitemap(pages, state):
    urls = []
    for p in pages:
        if not p.get("sitemap"):
            continue
        loc = SITE + (p["path"] if p["path"] != "/" else "/")
        img = "".join("\n    <image:image><image:loc>%s</image:loc><image:title>%s</image:title></image:image>"
                      % (e(u), e(t)) for u, t in p.get("images", []))
        urls.append("  <url>\n    <loc>%s</loc>\n    <lastmod>%s</lastmod>\n    <changefreq>%s</changefreq>\n"
                    "    <priority>%s</priority>%s\n  </url>"
                    % (e(loc), state[p["path"]]["lastmod"], p["changefreq"], p["priority"], img))
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
            'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n' + "\n".join(urls) + "\n</urlset>\n")


def robots():
    bots = ["Googlebot", "Bingbot", "DuckDuckBot", "YandexBot", "Applebot", "GPTBot", "OAI-SearchBot",
            "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "PerplexityBot", "Perplexity-User",
            "Google-Extended", "CCBot"]
    groups = "\n".join("User-agent: %s" % b for b in bots)
    return f"""# robots.txt for stocksaathi.co.in
# Search engines AND AI assistants are welcome: they are how most students
# find StockSaathi. The only things kept out are the admin console and the
# noindex app shell that signed-in pages load into.

{groups}
Allow: /
Disallow: /a/
Disallow: /app-shell

User-agent: *
Allow: /
Disallow: /a/
Disallow: /app-shell

Sitemap: {SITE}/sitemap.xml
"""


def page_titles(pages):
    titles = {p["path"]: p["title"] for p in pages
              if not p.get("legal") and p["path"] not in ("/app-shell", "/404")
              and not p["path"].startswith("/stocks/")}
    return ("// GENERATED by scripts/prerender.py. Do not edit by hand.\n"
            "// document.title for in-app navigation, matching the pre-rendered <title>.\n"
            "export const PAGE_TITLES = " + json.dumps(titles, ensure_ascii=False, indent=2) + ";\n")


def main():
    check = "--check" in sys.argv
    template = (ROOT / "index.html").read_text(encoding="utf-8")
    state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    pages = build_pages()

    outputs = {}
    new_state = {}
    for p in pages:
        if p.get("legal"):
            body = (ROOT / p["file"]).read_text(encoding="utf-8")
        else:
            body = render(p, template)
            outputs[ROOT / p["file"]] = body
        digest = hashlib.sha256(body.replace("\r\n", "\n").encode("utf-8")).hexdigest()[:16]
        prev = state.get(p["path"], {})
        lastmod = prev.get("lastmod") if prev.get("hash") == digest else TODAY
        new_state[p["path"]] = {"hash": digest, "lastmod": lastmod or TODAY}

    check_copy_counts([(str(f.relative_to(ROOT)), t) for f, t in outputs.items()] +
                      [(n, (ROOT / n).read_text(encoding="utf-8")) for n in ("llms.txt", "index.html")])

    outputs[ROOT / "sitemap.xml"] = sitemap(pages, new_state)
    outputs[ROOT / "robots.txt"] = robots()
    outputs[ROOT / "js" / "pageTitles.js"] = page_titles(pages)
    outputs[STATE] = json.dumps(new_state, indent=1, sort_keys=True) + "\n"

    # Generated stock / replay pages that no longer exist in the data.
    keep = {f for f in outputs}
    stale_files = [f for d in ("stocks", "crash-replay") for f in (ROOT / d).glob("*.html") if f not in keep] \
        if (ROOT / "stocks").exists() else []

    def same(path, text):
        return path.exists() and path.read_text(encoding="utf-8").replace("\r\n", "\n") == text.replace("\r\n", "\n")

    changed = [f for f, t in outputs.items() if not same(f, t) and f != STATE]
    if check:
        if changed or stale_files:
            print("prerender outputs stale (%d changed, %d orphaned) - run: python scripts/prerender.py"
                  % (len(changed), len(stale_files)))
            for f in (changed + stale_files)[:10]:
                print("  ", f.relative_to(ROOT))
            sys.exit(1)
        print("prerender outputs up to date (%d pages)" % len(pages))
        return
    for f, text in outputs.items():
        if same(f, text):                    # untouched: keeps git's line endings / mtime
            continue
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text, encoding="utf-8", newline="\n")
    for f in stale_files:
        f.unlink()
    print("pages: %d  changed: %d  removed: %d" % (len(pages), len(changed), len(stale_files)))


if __name__ == "__main__":
    main()
