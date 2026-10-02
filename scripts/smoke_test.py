#!/usr/bin/env python3
"""
Pre-push smoke test. Starts scripts/dev_server.py, loads every route in a
headless browser, and fails on:
  - an HTTP status other than the expected one,
  - any console error or uncaught page error (CSP violations included),
  - a same-origin request that 4xx/5xx's (API proxy excluded: upstream state
    is not what we are testing),
  - an empty #main after render,
  - routing regressions: in-app link clicks must change the URL without a
    full reload, back/forward must re-render, and legacy "#/x" links must land
    on "/x".

Needs Playwright. On this machine it lives in the claude-seo runtime:
  set PLAYWRIGHT_BROWSERS_PATH=%LOCALAPPDATA%\\claude-seo\\ms-playwright
  "%LOCALAPPDATA%\\claude-seo\\.venv\\Scripts\\python.exe" scripts\\smoke_test.py

Exit code 0 = pass. Extra routes: pass paths as arguments.
"""

import html
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PORT = 7351
BASE = "http://127.0.0.1:%d" % PORT

# (path, expected status, css selector that must exist after render)
ROUTES = [
    ("/", 200, "#main .hero"),
    ("/stocks", 200, "#main h1"),
    ("/stocks/RELIANCE", 200, "#main"),
    ("/stocks/AANCHALISP", 200, "#main"),
    ("/crash-replay", 200, "#main .crash-scenarios"),
    ("/crash-replay/COVID_2020", 200, "#main"),
    ("/crash-replay/GFC_2008", 200, "#main"),
    ("/crash-replay/DEMO_2016", 200, "#main"),
    ("/news", 200, "#main"),
    ("/chat", 200, "#main"),
    ("/login", 200, "#main form, #main input"),
    ("/register", 200, "#main input"),
    ("/privacy", 200, "h1"),
    ("/terms", 200, "h1"),
    ("/grievance", 200, "h1"),
    ("/portfolio", 200, "#main"),          # gated → redirects to /login client-side
    ("/robots.txt", 200, None),
    ("/sitemap.xml", 200, None),
    ("/manifest.json", 200, None),
    ("/this-route-does-not-exist", 404, None),
    # Deployment-exclusion guard: internal files must not be served, and the
    # app's own modules must be (an unanchored .vercelignore rule once
    # dropped js/db/ from production).
    ("/STATUS.md", 404, None),
    ("/docs/seo-plan.md", 404, None),
    ("/js/db/sync.js", 200, None),
    ("/js/db/supabase.js", 200, None),
    # Phase 3: pre-rendered pages + assets
    ("/learn-stock-market", 200, "#main h1"),
    ("/for-students", 200, "#main h1"),
    ("/stocks/M%26M", 200, "#main"),
    ("/llms.txt", 200, None),
    ("/favicon.ico", 200, None),
    ("/images/og-image.png", 200, None),
    ("/images/icon-512.png", 200, None),
    ("/partials/landing.html", 404, None),
    ("/compare/devion", 404, None),
]

# Crawler view (JavaScript OFF): path -> (expected <h1> fragment, indexable?)
CRAWLER_PAGES = {
    "/": ("Invest virtually", True),
    "/stocks": ("NSE and BSE stocks", True),
    "/stocks/RELIANCE": ("Reliance Industries", True),
    "/stocks/M&M": ("Mahindra", True),
    "/crash-replay": ("crash simulator", True),
    "/crash-replay/COVID_2020": ("COVID-19", True),
    "/crash-replay/GFC_2008": ("Global Financial Crisis", True),
    "/crash-replay/DEMO_2016": ("Demonetisation", True),
    "/chat": ("AI stock market coach", True),
    "/learn-stock-market": ("learn the stock market", True),
    "/for-students": ("students", True),
    "/news": ("news", False),
    "/login": (None, False),          # app shell
    "/portfolio": (None, False),
    "/stocks/AANCHALISP": (None, False),  # failed the data-quality gate, no page: shell, noindex
    "/stocks/SPICEJET": ("SpiceJet", False),  # outside the Nifty 500: own page, but noindex
    "/stocks/AAIL": ("Akar Auto", False),     # BSE-only, outside the Nifty 500: own page, noindex
}

# Console noise judged elsewhere. "Failed to load resource" carries no URL, so
# failed requests are instead judged per-URL by the response listener: a
# same-origin non-API failure fails the route; third-party and upstream-API
# failures (RSS proxy, production API hiccups) are reported but don't block.
IGNORE = (
    "Failed to load resource",
)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def wait_for_server():
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + "/robots.txt", timeout=1)
            return
        except Exception:
            time.sleep(0.2)
    raise SystemExit("dev server did not start")


def main():
    extra = [(p, 200, "#main") for p in sys.argv[1:]]
    routes = ROUTES + extra
    for gen_script in ("build_landing.py", "prerender.py"):
        gen = subprocess.run([sys.executable, str(ROOT / "scripts" / gen_script), "--check"],
                             cwd=ROOT, capture_output=True, text=True)
        if gen.returncode != 0:
            print("FAIL  generated files are stale (%s): %s" % (gen_script, gen.stdout.strip()))
            sys.exit(1)
    srv = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "dev_server.py"), str(PORT), "-q"],
                           cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    failures, report = [], []
    try:
        wait_for_server()
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context(service_workers="block")
            for path, want, selector in routes:
                page = ctx.new_page()
                errors, bad, warn = [], [], []
                page.on("console", lambda m, e=errors: m.type == "error" and e.append(m.text))
                page.on("pageerror", lambda ex, e=errors: e.append("pageerror: %s" % ex))

                def on_response(r, b=bad, w=warn, p=path):
                    if r.status < 400:
                        return
                    own = r.url.startswith(BASE)
                    if own and "/api/" not in r.url and r.url.split("?")[0] != BASE + p:
                        b.append("%d %s" % (r.status, r.url))
                    else:
                        w.append("%d %s" % (r.status, r.url[:140]))
                page.on("response", on_response)
                # A refused / aborted same-origin request never produces a
                # response event, but a failed module load kills the app.
                page.on("requestfailed", lambda r, b=bad: r.url.startswith(BASE) and "/api/" not in r.url
                        and b.append("FAILED %s %s" % (r.url, r.failure)))
                resp = page.goto(BASE + path, wait_until="networkidle", timeout=45000)
                status = resp.status if resp else 0
                page.wait_for_timeout(600)
                errs = [e for e in errors if not any(i in e for i in IGNORE)]
                ok = status == want and not errs and not bad
                if ok and selector:
                    ok = page.locator(selector).count() > 0
                    if not ok:
                        errs.append("selector missing: " + selector)
                if ok and want == 200 and selector:
                    txt = page.evaluate("() => (document.getElementById('main')||document.body).innerText.trim().length")
                    if txt < 20:
                        ok = False
                        errs.append("main is empty")
                report.append({"path": path, "status": status, "final": page.url.replace(BASE, ""),
                               "ok": ok, "errors": errs, "bad_requests": bad,
                               "warnings": [w for w in warn if "rss2json" not in w]})
                if not ok:
                    failures.append(path)
                page.close()

            # --- routing behaviour -------------------------------------------
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda ex: errors.append(str(ex)))
            page.goto(BASE + "/", wait_until="networkidle")
            page.evaluate("() => { window.__noReload = 1; }")
            checks = []

            # 1. in-app link → pushState, no reload
            link = page.locator("a[href^='/crash-replay']:visible").first
            if link.count():
                link.click()
                page.wait_for_timeout(800)
                same_doc = page.evaluate("() => window.__noReload === 1")
                checks.append(("link click is client-side", same_doc and "/crash-replay" in page.url))
            else:
                checks.append(("crash-replay link present on /", False))

            # 2. back button re-renders the previous route
            page.go_back()
            page.wait_for_timeout(800)
            checks.append(("back → /", page.url.rstrip("/") == BASE and page.locator("#main .hero").count() > 0))

            # 3. legacy hash links
            for legacy, target in (("/#/login", "/login"), ("/#/stocks/TCS", "/stocks/TCS"),
                                   ("/#/crash-replay/COVID_2020", "/crash-replay/COVID_2020")):
                page.goto(BASE + legacy, wait_until="networkidle")
                page.wait_for_timeout(500)
                checks.append(("%s → %s" % (legacy, target), page.url == BASE + target))

            # 4. /market alias
            page.goto(BASE + "/market", wait_until="networkidle")
            checks.append(("/market → /stocks", page.url == BASE + "/stocks"))

            # 5. crawler view == app view. What a non-JS crawler reads on "/"
            #    must be what the SPA renders there (no cloaking, no drift).
            nojs = browser.new_context(java_script_enabled=False).new_page()
            nojs.goto(BASE + "/", wait_until="load")
            static_txt = " ".join(nojs.inner_text("#main").split())
            nojs.context.close()
            page.goto(BASE + "/news", wait_until="networkidle")
            page.locator(".brand-logo").first.click()        # logged out → href="/"
            page.wait_for_timeout(1000)
            app_txt = " ".join(page.inner_text("#main").split())
            checks.append(("crawler text == SPA text on /", static_txt == app_txt and len(static_txt) > 1500))
            for must in ("NSE and BSE", "ages 13", "Frequently asked questions", "Is StockSaathi free?"):
                checks.append(("raw HTML has '%s'" % must, must in static_txt))

            # 6. crawler view of every public page (JS off): own title, own h1,
            #    self canonical, right robots directive.
            seen_titles = {}
            for path, (h1_frag, indexable) in CRAWLER_PAGES.items():
                raw = urllib.request.urlopen(BASE + urllib.parse.quote(path, safe="/"), timeout=10).read().decode("utf-8")
                title = re.search(r"<title>(.*?)</title>", raw, re.S).group(1)
                robots = re.search(r'<meta name="robots" content="([^"]+)"', raw).group(1)
                ok = ("noindex" not in robots) == indexable
                if indexable:
                    canon = re.search(r'<link rel="canonical" href="([^"]+)"', raw)
                    ok = ok and canon is not None and canon.group(1) == "https://stocksaathi.co.in" + path
                    ok = ok and title not in seen_titles
                    seen_titles[title] = path
                if h1_frag:
                    h1 = re.search(r"<h1[^>]*>(.*?)</h1>", raw, re.S)
                    ok = ok and h1 is not None and h1_frag.lower() in re.sub(r"<[^>]+>", "", h1.group(1)).lower()
                checks.append(("crawler view %s" % path, ok))

            # 7. static content page survives SPA boot and in-app navigation
            page.goto(BASE + "/learn-stock-market", wait_until="networkidle")
            checks.append(("static page kept after boot", page.locator("#main h1").inner_text().startswith("How to learn")))
            page.goto(BASE + "/", wait_until="networkidle")
            page.locator("footer a[href='/for-students']").click()
            page.wait_for_timeout(1500)
            checks.append(("footer link → /for-students client-side",
                           page.url == BASE + "/for-students" and page.locator("#main h1").count() == 1))
            checks.append(("document.title follows route", "Students" in page.title()))

            # 7b. what Google indexes is the rendered DOM: on a cold load of an
            #     app route the pre-rendered <title> survives, the pre-rendered
            #     article stays below the app (#seo-companion), there is exactly
            #     one <h1>, and the article goes away on in-app navigation.
            for path, frag in (("/stocks/RELIANCE", "How RELIANCE has recovered"),
                               ("/crash-replay/COVID_2020", "What happened, day by day")):
                raw = urllib.request.urlopen(BASE + path, timeout=10).read().decode("utf-8")
                raw_title = html.unescape(re.search(r"<title>(.*?)</title>", raw, re.S).group(1))
                page.goto(BASE + path, wait_until="networkidle")
                page.wait_for_timeout(1500)
                comp = page.locator("#seo-companion")
                checks.append(("rendered %s keeps pre-rendered title" % path, page.title() == raw_title))
                checks.append(("rendered %s keeps article below app" % path,
                               # text_content: the companion uses content-visibility:auto,
                               # so off-screen it is in the DOM but not in innerText.
                               comp.count() == 1 and frag in (comp.text_content() or "")))
                checks.append(("rendered %s has one h1" % path, page.locator("h1").count() == 1))
            page.locator("footer a[href='/learn-stock-market']").click()
            page.wait_for_timeout(1500)
            checks.append(("companion removed on in-app navigation", page.locator("#seo-companion").count() == 0))

            # 8. cleanUrls: .html paths redirect to the clean URL
            for legacy_html, clean in (("/index.html", "/"), ("/privacy.html", "/privacy")):
                req = urllib.request.Request(BASE + legacy_html, method="HEAD")
                try:
                    code, loc = 200, None
                    urllib.request.build_opener(NoRedirect).open(req, timeout=5)
                except urllib.error.HTTPError as err:
                    code, loc = err.code, err.headers.get("Location")
                checks.append(("%s → 308 %s" % (legacy_html, clean), code == 308 and loc == clean))

            for name, passed in checks:
                report.append({"check": name, "ok": bool(passed)})
                if not passed:
                    failures.append(name)
            if errors:
                failures.append("routing page errors")
                report.append({"check": "routing page errors", "ok": False, "errors": errors})
            browser.close()
    finally:
        srv.terminate()

    for r in report:
        mark = "PASS" if r["ok"] else "FAIL"
        label = r.get("path") or r.get("check")
        detail = ""
        if "status" in r:
            detail = " [%s -> %s]" % (r["status"], r["final"])
        print("%s  %s%s" % (mark, label, detail))
        for e in r.get("errors", []) + r.get("bad_requests", []):
            print("        %s" % e[:300])
        for w in r.get("warnings", []):
            print("        (warn, not blocking) %s" % w)
    print("\n%d checks, %d failed" % (len(report), len(failures)))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
