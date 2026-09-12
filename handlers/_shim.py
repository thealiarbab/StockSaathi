"""
ASGI shim over the BaseHTTPRequestHandler modules in this directory.

WHY THIS EXISTS
---------------
Vercel creates one serverless function per file under `api/`. With 16 Python
handlers plus 2 Node ones that was 18-21 functions against the Hobby plan's
limit of 12, so every deployment since 2026-05-05 failed at `patchBuild` with
`exceeded_serverless_functions_per_deployment`. The build succeeded first, so
the dashboard showed a failure while the site kept serving the last good
deployment and nothing looked broken.

The handlers therefore live here, outside `api/`, where Vercel does not
auto-functionize them. A single entrypoint (`api/index.py`) exposes the ASGI
app built here and dispatches to them. 16 functions collapse into 1.

No handler logic changed. This shim imports each module unchanged and replays
the BaseHTTPRequestHandler protocol into an ASGI response — the same technique
`api-backup/main.py` has used for the Fly.io failover origin since April, which
is why that file now imports from here rather than keeping a second copy.

ROUTE RESOLUTION
----------------
Vercel rewrites `/api/*` to the single entrypoint. Whether the ASGI app then
observes the original path or the rewritten one is deployment-specific, so
`resolve_stem` tries several sources in order and, on a miss, returns a
diagnostic 404 naming everything it looked at. That turns a guess into a
measurement on the first preview deploy.
"""

import importlib.util
import io
import os
import pathlib
import sys
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

_DIR = pathlib.Path(__file__).resolve().parent

# Handlers do `from _yahoo_session import ...` for their sibling underscore
# helpers. When run as Vercel functions each file's own directory happened to
# be on sys.path; loading them via spec_from_file_location gives no such
# guarantee, so put it there explicitly. send-consent.py in particular has a
# bare `from _email import ...` fallback with no sys.path.insert of its own.
if str(_DIR) not in sys.path:
    sys.path.insert(0, str(_DIR))


# ---------------------------------------------------------------------------
# Route registry — path suffix -> module stem in this directory.
# Parity with the files on disk is enforced by
# api-backup/tests/test_route_parity.py, which fails CI in both directions.
# ---------------------------------------------------------------------------
ROUTES = {
    "": "index",
    "index": "index",
    "health": "health",
    "config": "config",
    "quote": "quote",
    "quotes": "quotes",
    "live-quote": "live-quote",
    "universe-quotes": "universe-quotes",
    "history": "history",
    "mf-history": "mf-history",
    "fundamentals": "fundamentals",
    "screener": "screener",
    "send-consent": "send-consent",
    "admin-sync-instruments": "admin-sync-instruments",
    "admin-sync-fundamentals": "admin-sync-fundamentals",
    "admin-sync-mf": "admin-sync-mf",
    "admin-refresh-fundamentals": "admin-refresh-fundamentals",
}


def _load(stem: str):
    """Import <stem>.py from this directory. Stems may contain hyphens."""
    key = "ss_handler_" + stem.replace("-", "_")
    cached = sys.modules.get(key)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(key, _DIR / f"{stem}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[key] = mod
    spec.loader.exec_module(mod)
    return mod


class _BodyWriter:
    """File-like stand-in for BaseHTTPRequestHandler.wfile."""
    __slots__ = ("buf",)

    def __init__(self):
        self.buf = bytearray()

    def write(self, data):
        if isinstance(data, str):
            data = data.encode("utf-8")
        self.buf.extend(data)


class _HeadersAdapter:
    """Starlette Headers wrapped to behave like http.client.HTTPMessage.

    Handlers call self.headers.get('Content-Length', 0); Starlette returns
    None for a missing key rather than honouring the default.
    """
    __slots__ = ("_h",)

    def __init__(self, starlette_headers):
        self._h = starlette_headers

    def get(self, key, default=None):
        v = self._h.get(key.lower())
        return default if v is None else v

    def __getitem__(self, key):
        return self._h[key.lower()]

    def __contains__(self, key):
        return key.lower() in self._h


def _normalize(candidate: str) -> str:
    """'/api/quote?symbol=X' -> 'quote'."""
    if not candidate:
        return ""
    c = candidate.split("?", 1)[0].strip()
    if c.startswith("http://") or c.startswith("https://"):
        c = "/" + c.split("/", 3)[-1] if c.count("/") >= 3 else c
    c = c.strip("/")
    if c.startswith("api/"):
        c = c[4:]
    return c


def resolve_stem(request: Request) -> tuple[Optional[str], dict]:
    """Work out which handler this request is for.

    Returns (stem_or_None, diagnostics). Tries, in order: the ASGI path, then
    the headers Vercel sets when a rewrite has occurred, then the `__path`
    query fallback the rewrite in vercel.json supplies. Diagnostics are echoed
    on a miss so a single preview request reveals which source is authoritative
    rather than requiring a guess.
    """
    seen = {}
    candidates = []

    # ORDER MATTERS. `__path` is set explicitly by the rewrite in vercel.json
    # and must win. Once that rewrite fires the ASGI path is always
    # "/api/index" — which is itself a valid route — so checking the path
    # first made every endpoint resolve to the index ping handler. Caught by
    # handlers/../ local TestClient run before this ever deployed.
    qp = request.query_params.get("__path")
    if qp:
        seen["__path_query"] = qp
        candidates.append(qp)

    for header in ("x-vercel-original-path", "x-original-path",
                   "x-vercel-rewrite-path", "x-forwarded-uri"):
        val = request.headers.get(header)
        if val:
            seen[header] = val
            candidates.append(val)

    # Last: the literal ASGI path, for direct hits that bypassed the rewrite.
    # Skipped when __path was supplied — under the rewrite the ASGI path is
    # always "/api/index", so falling through to it would resolve every
    # unknown route to the index banner instead of returning 404.
    seen["asgi_path"] = request.url.path
    if not qp:
        candidates.append(request.url.path)

    for cand in candidates:
        stem_key = _normalize(cand)
        if stem_key in ROUTES:
            return ROUTES[stem_key], seen

    seen["tried"] = [_normalize(c) for c in candidates]
    return None, seen


def create_app(title: str = "StockSaathi API") -> FastAPI:
    app = FastAPI(title=title, docs_url=None, redoc_url=None)

    @app.get("/__up", include_in_schema=False)
    async def _up():
        return {"ok": True, "runtime": os.environ.get("RUNTIME", "vercel")}

    async def _dispatch(request: Request) -> Response:
        stem, diag = resolve_stem(request)
        if stem is None:
            # Deliberately verbose: this is the one failure mode that cannot be
            # reasoned about ahead of a real deployment.
            return JSONResponse(
                status_code=404,
                content={"ok": False, "error": "no_route", "saw": diag,
                         "known": sorted(set(ROUTES.values()))},
            )

        handler_cls = _load(stem).handler
        body = await request.body()

        # Reconstruct the URL the client actually requested. Handlers parse
        # self.path themselves, and under the rewrite request.url.path is
        # "/api/index" with a synthetic __path param bolted on — passing that
        # through would confuse any handler that inspects its own path.
        qs_pairs = [(k, v) for k, v in request.query_params.multi_items()
                    if k != "__path"]
        original = request.query_params.get("__path")
        if original:
            base = "/api/" + original.split("?", 1)[0].strip("/").removeprefix("api/")
        else:
            base = request.url.path
        full_path = base
        if qs_pairs:
            from urllib.parse import urlencode
            full_path += "?" + urlencode(qs_pairs)

        # Bypass BaseHTTPRequestHandler.__init__, which expects a real socket.
        h = object.__new__(handler_cls)
        h.command = request.method
        h.path = full_path
        h.headers = _HeadersAdapter(request.headers)
        h.rfile = io.BytesIO(body)
        h._status = 200
        h._headers_out = []
        h.wfile = _BodyWriter()
        h.send_response = lambda code, *a: setattr(h, "_status", code)
        h.send_header = lambda k, v: h._headers_out.append((k, str(v)))
        h.end_headers = lambda: None

        fn = getattr(h, f"do_{request.method}", None)
        if fn is None:
            return Response(status_code=405, content=b"")
        fn()

        merged = {}
        for k, v in h._headers_out:
            merged[k] = v
        # Starlette recomputes these; echoing ours corrupts the response.
        merged.pop("Content-Length", None)
        merged.pop("content-length", None)
        return Response(content=bytes(h.wfile.buf),
                        status_code=h._status, headers=merged)

    # Catch-all. Registered last so /__up above still wins.
    app.add_api_route("/{full_path:path}", _dispatch,
                      methods=["GET", "POST", "OPTIONS"],
                      include_in_schema=False)
    return app
