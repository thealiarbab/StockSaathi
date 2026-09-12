"""
FastAPI shim over app/api/*.py — backup origin for Vercel failover.

Every handler file in ../api/ is a BaseHTTPRequestHandler subclass. This
shim imports each one unchanged and replays the handler protocol into a
FastAPI Response. Zero logic changes in the primary handlers; the only
backup-specific code lives here.

Run locally:   uvicorn main:app --host 0.0.0.0 --port 8080
In Docker:     see ./Dockerfile
"""

import importlib.util
import io
import os
import pathlib
import sys
from typing import Callable

from fastapi import FastAPI, Request
from fastapi.responses import Response

# Handlers live in ../api/ relative to this file.
_API_DIR = pathlib.Path(__file__).resolve().parent.parent / "api"

app = FastAPI(title="StockSaathi backup API", docs_url=None, redoc_url=None)


def _load(stem: str):
    """Load app/api/<stem>.py by path (file stems can have hyphens)."""
    safe = stem.replace("-", "_")
    key = f"stocksaathi_api_{safe}"
    cached = sys.modules.get(key)
    if cached is not None:
        return cached
    path = _API_DIR / f"{stem}.py"
    spec = importlib.util.spec_from_file_location(key, path)
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
    """Wrap Starlette Headers so .get() accepts Vercel-style calls.

    Vercel handlers call self.headers.get('Content-Length', 0) — Starlette's
    Headers supports .get() but returns None for missing keys. This proxy
    preserves the default-argument behaviour and case-insensitive lookup.
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


def _route_for(stem: str) -> Callable:
    """Build an async FastAPI handler that dispatches to the module's `handler` class."""
    handler_cls = _load(stem).handler

    async def route(request: Request) -> Response:
        body = await request.body()
        full_path = request.url.path
        if request.url.query:
            full_path += "?" + request.url.query

        # Bypass BaseHTTPRequestHandler.__init__ (which expects a real socket).
        h = object.__new__(handler_cls)
        h.command = request.method
        h.path = full_path
        h.headers = _HeadersAdapter(request.headers)
        h.rfile = io.BytesIO(body)
        h._status = 200
        h._headers_out = []
        h.wfile = _BodyWriter()

        def _send_response(code, *_args):
            h._status = code

        def _send_header(k, v):
            h._headers_out.append((k, str(v)))

        h.send_response = _send_response
        h.send_header = _send_header
        h.end_headers = lambda: None

        fn = getattr(h, f"do_{request.method}", None)
        if fn is None:
            return Response(status_code=405, content=b"")
        fn()

        # De-dupe headers by last-write-wins (FastAPI dict won't accept dupes).
        merged = {}
        for k, v in h._headers_out:
            merged[k] = v
        # Strip hop-by-hop headers we shouldn't echo ourselves.
        merged.pop("Content-Length", None)
        return Response(
            content=bytes(h.wfile.buf),
            status_code=h._status,
            headers=merged,
        )

    return route


# ---------------------------------------------------------------------------
# Route registry — must mirror app/api/*.py. Parity is enforced by
# tests/test_route_parity.py, which fails CI if a new handler is added to
# app/api/ without a corresponding entry here.
# ---------------------------------------------------------------------------
_ROUTES = {
    "/api/": "index",
    "/api/health": "health",
    "/api/config": "config",
    "/api/quote": "quote",
    "/api/quotes": "quotes",
    "/api/live-quote": "live-quote",
    "/api/universe-quotes": "universe-quotes",
    "/api/history": "history",
    "/api/fundamentals": "fundamentals",
    "/api/send-consent": "send-consent",
    "/api/admin-sync-instruments": "admin-sync-instruments",
    "/api/admin-sync-fundamentals": "admin-sync-fundamentals",
    "/api/admin-sync-mf": "admin-sync-mf",
    "/api/mf-history": "mf-history",
    # Added 2026-09-13: these two existed in app/api/ but were never
    # registered here, so tests/test_route_parity.py failed and took the
    # whole backup-deploy workflow down with it (parity-check is the first
    # job and everything else needs: it).
    "/api/screener": "screener",
    "/api/admin-refresh-fundamentals": "admin-refresh-fundamentals",
}

_METHODS = ["GET", "POST", "OPTIONS"]

for _path, _stem in _ROUTES.items():
    app.add_api_route(_path, _route_for(_stem), methods=_METHODS, include_in_schema=False)


@app.get("/__up", include_in_schema=False)
async def _up():
    """Fly.io internal health check endpoint."""
    return {"ok": True, "runtime": os.environ.get("RUNTIME", "fly")}
