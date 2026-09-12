"""FastAPI entrypoint for the Fly.io failover origin.

The dispatch logic moved to ../handlers/_shim.py so the Vercel entrypoint
(api/index.py) and this one cannot drift apart. Previously this file carried
its own copy of the BaseHTTPRequestHandler replay logic.

Run locally:   uvicorn main:app --host 0.0.0.0 --port 8080
In Docker:     see ./Dockerfile
"""

import pathlib
import sys

_HANDLERS = pathlib.Path(__file__).resolve().parent.parent / "handlers"
sys.path.insert(0, str(_HANDLERS))

from _shim import ROUTES, create_app  # noqa: E402

# Re-exported under the historical name so tests/test_route_parity.py keeps
# working against this module.
_ROUTES = {f"/api/{k}" if k else "/api/": v for k, v in ROUTES.items()}

app = create_app("StockSaathi backup API")
