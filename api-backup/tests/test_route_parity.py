"""
Parity check: every app/api/*.py handler must be registered in main._ROUTES.

Run:  pytest app/api-backup/tests/
If this test fails, a new handler was added to app/api/ without a matching
route in api-backup/main.py — the backup origin would be missing that endpoint.
"""

import pathlib
import sys

THIS_DIR = pathlib.Path(__file__).resolve().parent
BACKUP_DIR = THIS_DIR.parent
API_DIR = BACKUP_DIR.parent / "handlers"

sys.path.insert(0, str(BACKUP_DIR))


def _public_handlers():
    """Python files in app/handlers/ that are meant to be HTTP handlers."""
    for p in API_DIR.glob("*.py"):
        stem = p.stem
        if stem.startswith("_"):
            continue
        yield stem


def test_every_python_handler_has_a_route():
    from main import _ROUTES  # type: ignore[import]

    registered = set(_ROUTES.values())
    expected = set(_public_handlers())

    missing = expected - registered
    assert not missing, (
        f"Handlers present in app/api/ but not registered in api-backup/main.py: {sorted(missing)}. "
        f"Add them to _ROUTES so the backup origin serves them."
    )

    stale = registered - expected
    assert not stale, (
        f"Routes registered in api-backup/main.py but missing from app/api/: {sorted(stale)}. "
        f"Remove them from _ROUTES."
    )


def test_shim_boots():
    """Smoke test: the shim imports without side-effects blowing up."""
    import main  # type: ignore[import]
    assert hasattr(main, "app")
    assert len(main._ROUTES) > 0
