"""GET /api/news — a few hundred recent Indian market headlines in one cached reply.

WHY THIS EXISTS

The News page used to fetch six RSS feeds from the browser through rss2json,
whose free tier returns ~10 items per feed, and then kept 8 of each: about 40
headlines for the whole market. Fetched directly, the same publishers return
35-200 items per feed, and they publish one feed per sector. This endpoint
reads ~45 of them server-side, keeps the last three days (up to 1,000), and
is CDN-cached, so the feeds are read a few times an hour no matter how many
people open the page.

It also attaches every Saathi take already generated (ai_response_cache,
bucket news_tldr, written by /api/ai?op=news-tldr). A headline someone has
already looked at shows its take straight away, with no AI call at all.
That is one Supabase read per CDN refresh, not one per visitor.

Reply: {"ok": true, "n": <count>, "items": [{"h": headline, "s": summary,
        "src": source, "u": url, "ts": ms, "img": thumbnail|null,
        "take": {"sentiment", "tldr"}|absent}]}
?lang=hi returns the Hinglish takes instead (cached separately).
?n=60 returns only the newest 60 (coach panel, portfolio card), ~12 KB
instead of ~190 KB; any n from 1 to 1000 works, each is its own CDN copy.
"""

import gzip
import hashlib
import html
import json
import os
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from email.utils import parsedate_to_datetime
from datetime import datetime
from http.server import BaseHTTPRequestHandler

import _supa_http

# Checked 18 Oct 2026, fetched directly: 30-200 items each. Market, company
# and every sector section these publishers publish, so news on most listed
# companies turns up somewhere. Moneycontrol, NDTV Profit's own feed, Zee
# Business and Financial Express refuse or serve HTML; all left out.
FEEDS = [
    # Economic Times: markets + every industry section with a working feed
    ("https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", "Economic Times"),
    ("https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms", "Economic Times"),
    ("https://economictimes.indiatimes.com/markets/stocks/earnings/rssfeeds/2143429.cms", "Economic Times"),
    ("https://economictimes.indiatimes.com/markets/ipos/fpos/rssfeeds/14655708.cms", "Economic Times"),
    ("https://economictimes.indiatimes.com/markets/commodities/rssfeeds/1808152121.cms", "Economic Times"),
    ("https://economictimes.indiatimes.com/mf/rssfeeds/359241701.cms", "Economic Times"),
    ("https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms", "Economic Times"),
    ("https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms", "Economic Times"),
    ("https://economictimes.indiatimes.com/industry/banking/finance/rssfeeds/13358259.cms", "Economic Times"),
    ("https://economictimes.indiatimes.com/industry/auto/rssfeeds/13359412.cms", "Economic Times"),
    ("https://economictimes.indiatimes.com/industry/energy/rssfeeds/13358350.cms", "Economic Times"),
    ("https://economictimes.indiatimes.com/industry/healthcare/biotech/rssfeeds/13358050.cms", "Economic Times"),
    ("https://economictimes.indiatimes.com/industry/telecom/rssfeeds/13357555.cms", "Economic Times"),
    ("https://economictimes.indiatimes.com/industry/services/rssfeeds/13354120.cms", "Economic Times"),
    ("https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms", "Economic Times"),
    ("https://economictimes.indiatimes.com/small-biz/rssfeeds/5575607.cms", "Economic Times"),
    # LiveMint
    ("https://www.livemint.com/rss/markets", "LiveMint"),
    ("https://www.livemint.com/rss/companies", "LiveMint"),
    ("https://www.livemint.com/rss/economy", "LiveMint"),
    ("https://www.livemint.com/rss/money", "LiveMint"),
    ("https://www.livemint.com/rss/industry", "LiveMint"),
    # Business Standard
    ("https://www.business-standard.com/rss/markets-106.rss", "Business Standard"),
    ("https://www.business-standard.com/rss/companies-101.rss", "Business Standard"),
    ("https://www.business-standard.com/rss/economy-102.rss", "Business Standard"),
    ("https://www.business-standard.com/rss/finance-103.rss", "Business Standard"),
    ("https://www.business-standard.com/rss/industry-217.rss", "Business Standard"),
    ("https://www.business-standard.com/rss/markets/ipo-10601.rss", "Business Standard"),
    # BusinessLine
    ("https://www.thehindubusinessline.com/markets/feeder/default.rss", "BusinessLine"),
    ("https://www.thehindubusinessline.com/markets/stock-markets/feeder/default.rss", "BusinessLine"),
    ("https://www.thehindubusinessline.com/companies/feeder/default.rss", "BusinessLine"),
    ("https://www.thehindubusinessline.com/economy/feeder/default.rss", "BusinessLine"),
    ("https://www.thehindubusinessline.com/money-and-banking/feeder/default.rss", "BusinessLine"),
    # CNBC-TV18
    ("https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml", "CNBC-TV18"),
    ("https://www.cnbctv18.com/commonfeeds/v1/cne/rss/business.xml", "CNBC-TV18"),
    ("https://www.cnbctv18.com/commonfeeds/v1/cne/rss/economy.xml", "CNBC-TV18"),
    # Others
    ("https://www.thehindu.com/business/markets/feeder/default.rss", "The Hindu"),
    ("https://www.thehindu.com/business/feeder/default.rss", "The Hindu"),
    ("https://indianexpress.com/section/business/market/feed/", "Indian Express"),
    ("https://indianexpress.com/section/business/feed/", "Indian Express"),
    ("https://feeds.feedburner.com/ndtvprofit-latest", "NDTV Profit"),
    ("https://www.businesstoday.in/rssfeeds/?id=225346", "Business Today"),
    ("https://www.businesstoday.in/rssfeeds/?id=home", "Business Today"),
    ("https://www.goodreturns.in/rss/news-fb.xml", "Goodreturns"),
]

# Business Standard 403s anything that doesn't look like a browser.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/141.0 Safari/537.36")
FEED_TIMEOUT = 8
MAX_AGE_MS = 3 * 24 * 3600 * 1000   # some feeds carry items from 2025
MAX_ITEMS = 1000
TAKE_CHUNK = 120                    # keys per PostgREST in.() query, keeps URLs < 4 KB

_ITEM = re.compile(r"<item\b[^>]*>(.*?)</item>", re.S | re.I)
_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


def _field(block, name):
    m = re.search(r"<" + name + r"\b[^>]*>(.*?)</" + name + r">", block, re.S | re.I)
    if not m:
        return ""
    v = m.group(1).strip()
    if v.startswith("<![CDATA["):
        v = v[9:]
        if v.endswith("]]>"):
            v = v[:-3]
    return v


def _attr_url(block, tag):
    m = re.search(r"<" + tag + r"\b[^>]*\burl=\"([^\"]+)\"", block, re.I)
    return html.unescape(m.group(1)) if m else None


def _clean(s):
    # Twice: feeds often entity-escape their HTML (&lt;p&gt;...).
    s = html.unescape(s or "")
    s = _TAG.sub(" ", s)
    s = html.unescape(s)
    return _WS.sub(" ", s).strip()


def _ts(s):
    s = _clean(s)
    if not s:
        return None
    try:
        return int(parsedate_to_datetime(s).timestamp() * 1000)
    except Exception:
        pass
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None


def _fetch(feed):
    url, source = feed
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*",
            "Accept-Encoding": "gzip"})
        with urllib.request.urlopen(req, timeout=FEED_TIMEOUT) as r:
            raw = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
        text = raw.decode("utf-8", "replace")
    except Exception as e:
        print(f"[news] {source} {url} failed: {e}", flush=True)
        return []
    out = []
    for block in _ITEM.findall(text):
        headline = _clean(_field(block, "title"))
        link = _clean(_field(block, "link")) or _clean(_field(block, "guid"))
        if not headline or not link.startswith("http"):
            continue
        out.append({
            "h": headline,
            "s": _clean(_field(block, "description"))[:220],
            "src": source,
            "u": link,
            "ts": _ts(_field(block, "pubDate")) or _ts(_field(block, "dc:date")),
            "img": _attr_url(block, "media:content") or _attr_url(block, "media:thumbnail")
                   or _attr_url(block, "enclosure"),
        })
    return out


def take_key(headline, hinglish):
    # Must match sha12() + opNewsTldr in api/ai.js: headline trimmed and cut
    # to 300, then lowercased, whitespace collapsed, SHA-256, first 12 bytes.
    h = str(headline or "").strip()[:300]
    norm = _WS.sub(" ", h.strip().lower())[:400]
    return "h_" + hashlib.sha256(norm.encode("utf-8")).hexdigest()[:24] + ("_hi" if hinglish else "")


def _supa_key():
    return (os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
            or os.environ.get("SUPABASE_ANON_KEY", "").strip())


def load_takes(keys):
    """{cache_key: {"sentiment", "tldr"}} for keys that already have a take."""
    key = _supa_key()
    if not key or not keys:
        return {}
    headers = {"apikey": key, "Authorization": "Bearer " + key}
    found = {}
    for i in range(0, len(keys), TAKE_CHUNK):
        chunk = keys[i:i + TAKE_CHUNK]
        q = ("/rest/v1/ai_response_cache?select=cache_key,payload&bucket=eq.news_tldr"
             "&cache_key=in.(" + ",".join(urllib.parse.quote(k) for k in chunk) + ")")
        try:
            status, body = _supa_http.request("GET", q, headers=headers, timeout=5)
        except Exception as e:
            print(f"[news] takes read failed: {e}", flush=True)
            return found
        if status != 200:
            print(f"[news] takes read {status}", flush=True)
            return found
        for row in json.loads(body):
            p = row.get("payload") or {}
            if p.get("tldr") and p.get("sentiment"):
                found[row["cache_key"]] = {"sentiment": p["sentiment"], "tldr": p["tldr"]}
    return found


def build(hinglish, limit=MAX_ITEMS):
    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(_fetch, FEEDS))
    now = int(time.time() * 1000)
    seen, items = set(), []
    for it in (x for feed in results for x in feed):
        k = it["h"].lower()
        if k in seen:
            continue
        seen.add(k)
        if not it["ts"] or it["ts"] > now + 3600_000:
            continue   # undated or dated in the future: can't place it in time
        if now - it["ts"] > MAX_AGE_MS:
            continue
        items.append(it)
    items.sort(key=lambda x: x["ts"], reverse=True)
    items = items[:limit]
    keys = [take_key(it["h"], hinglish) for it in items]
    takes = load_takes(keys)
    for it, k in zip(items, keys):
        if k in takes:
            it["take"] = takes[k]
        if not it["img"]:
            del it["img"]
    return items, sum(1 for r in results if r)


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        hinglish = (qs.get("lang") or [""])[0] == "hi"
        try:
            limit = max(1, min(MAX_ITEMS, int((qs.get("n") or [MAX_ITEMS])[0])))
        except ValueError:
            limit = MAX_ITEMS
        try:
            items, feeds_ok = build(hinglish, limit)
        except Exception as e:
            print(f"[news] build failed: {e}", flush=True)
            self._json(502, {"ok": False, "error": "build_failed"}, cache=False)
            return
        if not items:
            self._json(502, {"ok": False, "error": "no_items"}, cache=False)
            return
        self._json(200, {"ok": True, "n": len(items), "feeds": feeds_ok, "items": items}, cache=True)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def _json(self, code, obj, cache):
        body = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cache:
            # Browser 2 min, CDN 10 min, and the CDN may hand out a copy up to
            # 30 min old while it refetches in the background. Each refetch is
            # ~45 feed reads + ~9 small Supabase reads, whatever the traffic.
            self.send_header("Cache-Control",
                             "public, max-age=120, s-maxage=600, stale-while-revalidate=1800")
        else:
            self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
