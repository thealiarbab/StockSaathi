"""Cross-device / cross-browser layout check.

    scripts\\device_check.cmd [out_dir]

Starts scripts/dev_server.py, then loads every key page on phone, tablet and
desktop profiles in WebKit (the Safari engine: iPhone, iPad, macOS),
Chromium (Android, Chrome) and Firefox, and reports per page:
  - horizontal overflow (page wider than the screen) and the elements causing it,
  - JavaScript errors,
  - visible tap targets smaller than 40px on touch devices,
and saves a full-page screenshot of each to out_dir for eyeballing.
Exit code 1 if any overflow or JS error was found.
"""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PORT = 7362
BASE = "http://127.0.0.1:%d" % PORT
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "scripts" / ".device-shots"

PAGES = ["/", "/stocks", "/stocks/RELIANCE", "/crash-replay", "/crash-replay/COVID_2020", "/chat",
         "/learn-stock-market", "/for-students", "/news", "/login", "/privacy", "/this-is-a-404"]

# name, browser, playwright device (or None), viewport override, touch
PROFILES = [
    ("iphone-se", "webkit", "iPhone SE", None),
    ("iphone-15", "webkit", "iPhone 15", None),
    ("ipad-mini", "webkit", "iPad Mini", None),
    ("pixel-7", "chromium", "Pixel 7", None),
    ("galaxy-s9", "chromium", "Galaxy S9+", None),
    ("desktop-safari", "webkit", None, {"width": 1440, "height": 900}),
    ("desktop-firefox", "firefox", None, {"width": 1366, "height": 768}),
    ("desktop-chrome", "chromium", None, {"width": 1280, "height": 800}),
]

PROBE = """() => {
  const vw = document.documentElement.clientWidth;
  const overflow = document.documentElement.scrollWidth - vw;
  const wide = [];
  if (overflow > 1) {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > vw + 1 || r.left < -1)) {
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' || cs.visibility === 'hidden') continue;
        wide.push((el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
          (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')) +
          ' ' + Math.round(r.left) + '..' + Math.round(r.right));
        if (wide.length > 6) break;
      }
    }
  }
  const small = [];
  for (const el of document.querySelectorAll('a, button, input, select, [role=button]')) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (!r.width || cs.visibility === 'hidden' || cs.display === 'none' || r.bottom < 0 || r.top > innerHeight * 3) continue;
    if (el.closest('.disclaimer, .crumbs, .link-list, .static-page p, .faq-item p, .replay-markers')) continue;   // inline text links
    if (r.height < 40 && r.width < 40) small.push((el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 24) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
  }
  return { vw, overflow, wide, small: small.slice(0, 8), h1: document.querySelectorAll('h1').length };
}"""


def main():
    sys.stdout.reconfigure(encoding="utf-8")       # emoji in button labels vs cp1252
    OUT.mkdir(parents=True, exist_ok=True)
    srv = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "dev_server.py"), str(PORT)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(BASE + "/", timeout=1)
                break
            except Exception:
                time.sleep(0.2)
        bad, report = 0, []
        with sync_playwright() as pw:
            for name, engine, device, viewport in PROFILES:
                browser = getattr(pw, engine).launch()
                opts = dict(pw.devices[device]) if device else {"viewport": viewport}
                if engine == "firefox":
                    opts.pop("is_mobile", None)
                ctx = browser.new_context(**opts, service_workers="block")
                page = ctx.new_page()
                errors = []
                page.on("pageerror", lambda e, errs=errors: errs.append(str(e)[:160]))
                touch = bool(opts.get("has_touch"))
                for path in PAGES:
                    errors.clear()
                    page.goto(BASE + path, wait_until="networkidle")
                    page.wait_for_timeout(5500 if path.startswith("/crash-replay/") else 1200)
                    info = page.evaluate(PROBE)
                    shot = OUT / ("%s%s.png" % (name, path.replace("/", "_") or "_home"))
                    page.screenshot(path=str(shot), full_page=False)
                    problems = []
                    if info["overflow"] > 1:
                        problems.append("overflow %dpx: %s" % (info["overflow"], "; ".join(info["wide"])))
                    if errors:
                        problems.append("js: " + " | ".join(errors))
                    if info["h1"] != 1 and path != "/this-is-a-404":
                        problems.append("h1 count %d" % info["h1"])
                    if touch and info["small"]:
                        problems.append("small taps: " + ", ".join(info["small"]))
                    hard = any(p.startswith(("overflow", "js")) for p in problems)
                    bad += hard
                    print("%-4s %-16s %-26s %s" % ("FAIL" if hard else ("WARN" if problems else "ok"), name, path,
                                                   " || ".join(problems)), flush=True)
                    report.append({"profile": name, "path": path, "problems": problems})
                browser.close()
        (OUT / "report.json").write_text(json.dumps(report, indent=1))
        print("\n%d hard failures; screenshots in %s" % (bad, OUT))
        return 1 if bad else 0
    finally:
        srv.terminate()


if __name__ == "__main__":
    sys.exit(main())
