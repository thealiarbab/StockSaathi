"""Single Vercel entrypoint for every Python API route.

Vercel creates one serverless function per file under api/. The Hobby plan
allows 12; we had 21, so every deploy since 2026-05-05 failed at patchBuild.
The handlers now live in ../handlers/ (which Vercel does not functionize) and
this one file dispatches to all of them. See handlers/_shim.py.
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "handlers"))

from _shim import create_app  # noqa: E402

app = create_app("StockSaathi API")
