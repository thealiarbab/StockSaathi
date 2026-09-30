#!/usr/bin/env python3
"""
Local server that routes requests the way Vercel does for this project.

Reads vercel.json and applies, in Vercel's order:
  1. redirects
  2. the filesystem (with cleanUrls when enabled)
  3. rewrites (first match wins; a rewrite to a missing file is a 404)
  4. 404.html with status 404
plus every matching `headers` rule, so the production CSP is enforced locally
and a CSP violation shows up in the smoke test instead of in production.

/api/* is proxied to production (read-only use: the smoke test never signs in
or trades). /_vercel/* returns 204, since those endpoints only exist on Vercel.

Usage:  python scripts/dev_server.py [port]      (default 7350)
Stdlib only.
"""

import json
import mimetypes
import re
import subprocess
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UPSTREAM = "https://stocksaathi.co.in"
CONFIG = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("text/plain", ".txt")
mimetypes.add_type("application/xml", ".xml")


def compile_source(src):
    """path-to-regexp subset used by vercel.json: `:name`, `:name(re)`,
    `:name*`, and raw regex groups. Returns (regex, param_names)."""
    out, names, i = "", [], 0
    while i < len(src):
        c = src[i]
        if c == ":":
            m = re.match(r":([A-Za-z_][A-Za-z0-9_]*)", src[i:])
            name = m.group(1)
            i += len(m.group(0))
            names.append(name)
            if i < len(src) and src[i] == "(":
                depth, j = 0, i
                while True:
                    if src[j] == "(":
                        depth += 1
                    elif src[j] == ")":
                        depth -= 1
                        if depth == 0:
                            break
                    j += 1
                out += "(?P<%s>%s)" % (name, src[i + 1:j])
                i = j + 1
            elif i < len(src) and src[i] == "*":
                out += "(?P<%s>.*)" % name
                i += 1
            else:
                out += "(?P<%s>[^/]+)" % name
        elif c == "(":
            depth, j = 0, i
            while True:
                if src[j] == "(":
                    depth += 1
                elif src[j] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            out += src[i:j + 1]
            i = j + 1
        elif c in ".+?^$|{}[]\\":
            out += "\\" + c
            i += 1
        else:
            out += c
            i += 1
    return re.compile("^" + out + "$"), names


def substitute(dest, m):
    groups = m.groupdict()
    for k, v in groups.items():
        dest = dest.replace(":" + k, v or "")
    for n, v in enumerate(m.groups(), start=1):
        dest = dest.replace("$%d" % n, v or "")
    return dest


def rule_applies(rule, headers):
    for cond in rule.get("has", []):
        if cond.get("type") == "host":
            return False          # host-conditional rules target www.; never local
        if cond.get("type") == "header":
            val = headers.get(cond["key"], "")
            if not re.search(cond.get("value", ".*"), val or ""):
                return False
    return True


REDIRECTS = [(compile_source(r["source"])[0], r) for r in CONFIG.get("redirects", [])]
REWRITES = [(compile_source(r["source"])[0], r) for r in CONFIG.get("rewrites", [])]
HEADERS = [(compile_source(r["source"])[0], r) for r in CONFIG.get("headers", [])]
CLEAN = bool(CONFIG.get("cleanUrls"))


def fs_lookup(path):
    """Return a file Path for a URL path, applying cleanUrls, or None."""
    rel = urllib.parse.unquote(path).lstrip("/")
    if ".." in Path(rel).parts:
        return None
    p = ROOT / rel
    if p.is_file():
        return p
    if p.is_dir() and (p / "index.html").is_file():
        return p / "index.html"
    if CLEAN and not rel.endswith(".html") and (ROOT / (rel + ".html")).is_file():
        return ROOT / (rel + ".html")
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "vercel-local"

    def log_message(self, fmt, *args):
        if "-q" not in sys.argv:
            sys.stderr.write("%s %s\n" % (self.command, fmt % args))

    def _headers_for(self, path):
        extra = {}
        for rx, rule in HEADERS:
            if rx.match(path):
                for h in rule["headers"]:
                    extra[h["key"]] = h["value"]
        return extra

    def _send(self, status, body=b"", ctype=None, path="/", extra=None):
        self.send_response(status)
        hdrs = self._headers_for(path)
        if extra:
            hdrs.update(extra)
        if ctype:
            hdrs["Content-Type"] = ctype
        hdrs.setdefault("Cache-Control", "no-store")
        hdrs["Content-Length"] = str(len(body))
        for k, v in hdrs.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _serve_file(self, fp, url_path, status=200):
        ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
        if fp.name.endswith(".json.br"):
            ctype = "application/json"
        if ctype.startswith("text/") or ctype in ("application/json", "application/xml", "text/javascript"):
            ctype += "; charset=utf-8"
        self._send(status, fp.read_bytes(), ctype, url_path)

    def _proxy(self, path_qs):
        body = b""
        if self.command == "POST":
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        cmd = ["curl", "-s", "-i", "--max-time", "25", "-X", self.command, UPSTREAM + path_qs]
        for h in ("Content-Type", "Authorization", "Accept"):
            if self.headers.get(h):
                cmd += ["-H", "%s: %s" % (h, self.headers[h])]
        if body:
            cmd += ["--data-binary", "@-"]
        try:
            raw = subprocess.run(cmd, input=body, capture_output=True, timeout=30).stdout
            head, _, payload = raw.partition(b"\r\n\r\n")
            while head.startswith(b"HTTP/") and b" 100 " in head.split(b"\r\n")[0]:
                head, _, payload = payload.partition(b"\r\n\r\n")
            lines = head.decode("latin-1").split("\r\n")
            status = int(lines[0].split()[1])
            ctype = "application/json"
            for ln in lines[1:]:
                if ln.lower().startswith("content-type:"):
                    ctype = ln.split(":", 1)[1].strip()
            self._send(status, payload, ctype, path_qs.split("?")[0])
        except Exception as e:  # upstream unreachable — say so, don't hang
            self._send(502, json.dumps({"error": "proxy_failed", "detail": str(e)}).encode(),
                       "application/json", "/api/")

    def _route(self):
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path or "/"
        qs = ("?" + parsed.query) if parsed.query else ""

        if path.startswith("/_vercel/"):
            # Vercel-only endpoints (Web Analytics). Serve an empty script so
            # the page behaves as in production minus the beacon.
            return self._send(200, b"", "text/javascript; charset=utf-8", path)
        if path.startswith("/api/"):
            return self._proxy(path + qs)

        for rx, rule in REDIRECTS:
            m = rx.match(path)
            if m and rule_applies(rule, self.headers):
                loc = substitute(rule["destination"], m)
                code = rule.get("statusCode") or (308 if rule.get("permanent", True) else 307)
                return self._send(code, b"", None, path, {"Location": loc + ("" if "?" in loc else qs)})

        if CLEAN and path.endswith(".html"):
            target = path[:-5]
            if target.endswith("/index"):
                target = target[:-5]
            if fs_lookup(path):
                return self._send(308, b"", None, path, {"Location": (target or "/") + qs})

        fp = fs_lookup(path)
        if fp:
            return self._serve_file(fp, path)

        for rx, rule in REWRITES:
            m = rx.match(path)
            if m and rule_applies(rule, self.headers):
                dest = substitute(rule["destination"], m).split("?")[0]
                fp = fs_lookup(dest)
                if fp:
                    return self._serve_file(fp, path)
                break                       # rewrite to a missing file → 404

        nf = ROOT / "404.html"
        if nf.is_file():
            return self._serve_file(nf, path, 404)
        return self._send(404, b"Not Found", "text/plain; charset=utf-8", path)

    def do_GET(self):
        self._route()

    def do_HEAD(self):
        self._route()

    def do_POST(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path.startswith("/api/"):
            return self._proxy(self.path)
        self._send(405, b"", None, parsed.path)


def main():
    port = int(next((a for a in sys.argv[1:] if a.isdigit()), "7350"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("serving %s on http://127.0.0.1:%d" % (ROOT, port), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
