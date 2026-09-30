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

import json
import subprocess
import sys
import time
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
    ("/stocks/SPICEJET", 200, "#main"),
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
]

# Console noise judged elsewhere. "Failed to load resource" carries no URL, so
# failed requests are instead judged per-URL by the response listener: a
# same-origin non-API failure fails the route; third-party and upstream-API
# failures (RSS proxy, production API hiccups) are reported but don't block.
IGNORE = (
    "Failed to load resource",
)


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
                resp = page.goto(BASE + path, wait_until="networkidle", timeout=45000)
                status = resp.status if resp else 0
                page.wait_for_timeout(600)
                errs = [e for e in errors if not any(i in e for i in IGNORE)]
                ok = status == want and not errs and not bad
                if ok and selector:
                    ok = page.locator(selector).count() > 0
                    if not ok:
                        errs.append("selector missing: " + selector)
                if ok and want == 200 and path.split("?")[0] not in ("/robots.txt", "/sitemap.xml", "/manifest.json"):
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
            link = page.locator("a[href='/crash-replay'], a[href='/crash-replay/COVID_2020']").first
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
