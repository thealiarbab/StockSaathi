"""Keep-alive, gzip-accepting HTTPS to Supabase REST for the quote handlers.

WHY THIS EXISTS

urllib.request opens a new TCP + TLS connection for every call and never asks
for compression. Supabase bills egress on every byte it sends, and a fresh TLS
handshake (certificate chain) costs ~2.8 KB, more than most quote responses.
Measured 17 Oct 2026: the quote handlers made ~70k Supabase calls a day, each
on its own connection, while the org was over its 5 GB egress quota.

One connection per worker thread, reused across requests while the instance
stays warm, pays the handshake once. A connection the server closed while we
were idle fails on first use; that is retried once on a fresh connection, which
is safe because every caller here is a read or an idempotent upsert.
"""

import gzip
import http.client
import os
import threading
import urllib.parse

_local = threading.local()

# What a dead idle connection raises on reuse: closed-socket OSErrors (SSL
# errors are OSErrors too) and http.client's protocol errors. A timeout is an
# OSError as well but means the server is slow, so it is not retried.
_STALE = (OSError, http.client.HTTPException)


def _host():
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    return urllib.parse.urlparse(url).hostname if url else None


def _conn(host, timeout):
    c = getattr(_local, "conn", None)
    if c is not None and getattr(_local, "host", None) == host:
        try:
            if c.sock is not None:
                c.sock.settimeout(timeout)
            else:
                c.timeout = timeout
            return c, True
        except OSError:
            pass   # socket already dead: fall through to a fresh one
    _drop()
    c = http.client.HTTPSConnection(host, timeout=timeout)
    _local.conn, _local.host = c, host
    return c, False


def _drop():
    c = getattr(_local, "conn", None)
    _local.conn = None
    if c is not None:
        try:
            c.close()
        except Exception:
            pass


def request(method, path, body=None, headers=None, timeout=3.0):
    """(status, body_bytes) for SUPABASE_URL + path. Raises on network failure.

    `path` starts with /rest/v1/... and is sent as-is (caller encodes it).
    """
    host = _host()
    if not host:
        raise RuntimeError("SUPABASE_URL unset")
    h = dict(headers or {})
    h.setdefault("Accept-Encoding", "gzip")
    for attempt in (0, 1):
        reused = False
        try:
            c, reused = _conn(host, timeout)
            c.request(method, path, body=body, headers=h)
            r = c.getresponse()
            data = r.read()
        except TimeoutError:
            _drop()
            raise
        except _STALE:
            _drop()
            if reused and attempt == 0:
                continue
            raise
        except Exception:
            _drop()
            raise
        if r.getheader("Content-Encoding", "").lower() == "gzip":
            data = gzip.decompress(data)
        if (r.getheader("Connection", "") or "").lower() == "close":
            _drop()
        return r.status, data
    raise RuntimeError("unreachable")
