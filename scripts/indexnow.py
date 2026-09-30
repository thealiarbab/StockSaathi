"""Ping IndexNow (Bing, Yandex, Seznam, Naver...) with site URLs.

Usage:
    python scripts/indexnow.py                 # every URL in sitemap.xml
    python scripts/indexnow.py /stocks /learn-stock-market

The key is proven by the file /<KEY>.txt at the site root, which must be
deployed before pinging. Only ping URLs that actually changed; engines
throttle hosts that resubmit unchanged pages.
"""
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

HOST = "stocksaathi.co.in"
KEY = "448b5ef0e83555a5524be82dbe99f74d"
ROOT = Path(__file__).resolve().parent.parent
BATCH = 10_000  # protocol maximum per request


def sitemap_urls():
    xml = (ROOT / "sitemap.xml").read_text(encoding="utf-8")
    return re.findall(r"<loc>(https://[^<]+)</loc>", xml)


def main(args):
    if args:
        urls = [a if a.startswith("http") else f"https://{HOST}{a}" for a in args]
    else:
        # Page URLs only; <image:loc> entries also use <loc> but live under /images/.
        urls = [u for u in sitemap_urls() if "/images/" not in u]
    if not (ROOT / f"{KEY}.txt").exists():
        sys.exit(f"missing key file {KEY}.txt at repo root")

    for i in range(0, len(urls), BATCH):
        chunk = urls[i:i + BATCH]
        body = json.dumps({
            "host": HOST,
            "key": KEY,
            "keyLocation": f"https://{HOST}/{KEY}.txt",
            "urlList": chunk,
        }).encode()
        req = urllib.request.Request(
            "https://api.indexnow.org/indexnow",
            data=body,
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                print(f"{len(chunk)} URLs -> HTTP {r.status}")
        except urllib.error.HTTPError as e:
            # 200/202 = accepted; 403 = key file not found; 422 = URL not on host.
            sys.exit(f"{len(chunk)} URLs -> HTTP {e.code}: {e.read()[:300]!r}")


if __name__ == "__main__":
    main(sys.argv[1:])
