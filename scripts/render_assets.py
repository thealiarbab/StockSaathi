#!/usr/bin/env python3
"""
Render the raster assets search engines, social apps and installers need.

SVG is fine in a browser, but WhatsApp / Facebook / LinkedIn / X will not show
an SVG link-preview image, Google Search wants a crawlable favicon file, and
Android installs want PNG icons. Everything here is rendered from the two
source SVGs (logo.svg, og-image.svg) with headless Chromium, so the PNGs never
drift from the vector originals.

Outputs (committed):
  images/og-image.png          1200x630  link previews
  images/logo-512.png           512x512  Organization logo (JSON-LD)
  images/icon-192.png           192x192  PWA icon
  images/icon-512.png           512x512  PWA icon
  images/maskable-512.png       512x512  PWA maskable icon (safe-zone padded)
  images/apple-touch-icon.png   180x180
  favicon.ico                   16/32/48 (PNG-in-ICO)
  images/favicon-48.png          48x48
  images/screenshot-wide.png   1280x720  manifest + image sitemap
  images/screenshot-narrow.png  780x1688 manifest (390x844 @2x)

Screenshots are taken from the local dev server (scripts/dev_server.py) so
they show the current build.

Needs Playwright (see scripts/smoke.cmd for the runtime on this machine).
Usage:  python scripts/render_assets.py [--no-screens]
"""

import struct
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "images"
PORT = 7362


def svg_page(svg, w, h, pad=0.0, bg="transparent"):
    inner = svg.replace("<svg ", '<svg style="width:100%;height:100%;display:block" ', 1)
    return (
        "<!doctype html><html><head>"
        '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700;800&display=swap" rel="stylesheet">'
        "<style>html,body{margin:0;background:%s}"
        ".box{width:%dpx;height:%dpx;display:grid;place-items:center}"
        ".in{width:%dpx;height:%dpx}</style></head><body>"
        '<div class="box"><div class="in">%s</div></div></body></html>'
    ) % (bg, w, h, int(w * (1 - 2 * pad)), int(h * (1 - 2 * pad)), inner)


def shot(page, html, w, h, out):
    page.set_viewport_size({"width": w, "height": h})
    page.set_content(html, wait_until="networkidle")
    page.wait_for_timeout(250)
    page.screenshot(path=str(out), omit_background=True, clip={"x": 0, "y": 0, "width": w, "height": h})


def write_ico(pngs, out):
    """ICO container holding PNG images (supported everywhere since Vista)."""
    entries, blobs = [], []
    offset = 6 + 16 * len(pngs)
    for size, data in pngs:
        entries.append(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset))
        blobs.append(data)
        offset += len(data)
    out.write_bytes(struct.pack("<HHH", 0, 1, len(pngs)) + b"".join(entries) + b"".join(blobs))


OG_VERSION = "v2"


def main():
    IMG.mkdir(exist_ok=True)
    logo = (ROOT / "logo.svg").read_text(encoding="utf-8")
    og = (ROOT / "og-image.svg").read_text(encoding="utf-8")
    # Maskable: full-bleed brand square, glyph inside the 80% safe zone.
    glyph = logo.split(">", 2)[2].rsplit("</svg>", 1)[0]          # drop xml decl + <svg>
    glyph = glyph.replace('<rect width="1024" height="1024" rx="224" fill="#00B386"/>', "")
    maskable = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
                '<rect width="1024" height="1024" fill="#00B386"/>'
                '<g transform="translate(153.6,153.6) scale(0.7)">%s</g></svg>') % glyph

    with sync_playwright() as pw:
        br = pw.chromium.launch()
        page = br.new_page(device_scale_factor=1)
        # Pages point at the versioned name: WhatsApp, X and LinkedIn cache a
        # preview per URL, so a changed image needs a new name. Bump OG_VERSION
        # here and OG_IMAGE in prerender.py together. og-image.png stays for
        # old links.
        shot(page, svg_page(og, 1200, 630), 1200, 630, IMG / "og-image.png")
        shot(page, svg_page(og, 1200, 630), 1200, 630, IMG / ("og-image-%s.png" % OG_VERSION))
        for size, name in ((512, "logo-512.png"), (192, "icon-192.png"), (512, "icon-512.png"),
                           (180, "apple-touch-icon.png"), (48, "favicon-48.png")):
            shot(page, svg_page(logo, size, size), size, size, IMG / name)
        shot(page, svg_page(maskable, 512, 512), 512, 512, IMG / "maskable-512.png")
        icos = []
        for size in (16, 32, 48):
            tmp = IMG / ("_ico%d.png" % size)
            shot(page, svg_page(logo, size, size), size, size, tmp)
            icos.append((size, tmp.read_bytes()))
            tmp.unlink()
        write_ico(icos, ROOT / "favicon.ico")

        if "--no-screens" not in sys.argv:
            srv = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "dev_server.py"), str(PORT), "-q"],
                                   cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for _ in range(50):
                    try:
                        urllib.request.urlopen("http://127.0.0.1:%d/robots.txt" % PORT, timeout=1)
                        break
                    except Exception:
                        time.sleep(0.2)
                for name, vw, vh, dpr in (("screenshot-wide.png", 1280, 720, 1),
                                          ("screenshot-narrow.png", 390, 844, 2)):
                    ctx = br.new_context(viewport={"width": vw, "height": vh}, device_scale_factor=dpr,
                                         service_workers="block")
                    p = ctx.new_page()
                    p.goto("http://127.0.0.1:%d/" % PORT, wait_until="networkidle")
                    p.wait_for_timeout(1200)
                    p.screenshot(path=str(IMG / name))
                    ctx.close()
            finally:
                srv.terminate()
        br.close()
    for f in sorted(IMG.glob("*.png")) + [ROOT / "favicon.ico"]:
        print("%-28s %7d bytes" % (f.relative_to(ROOT), f.stat().st_size))


if __name__ == "__main__":
    main()
