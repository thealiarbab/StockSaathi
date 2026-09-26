"""Batch handlers must stop themselves before Vercel does, and callers must
resume from where they actually stopped.

WHY THIS FILE EXISTS
--------------------
Two separate failures, same shape, found 2026-09-26:

* admin-warm-quotes had no time budget. 6 chunks x (45s timeout + retry)
  overran maxDuration on every cold-cache run; Vercel returned an HTML
  FUNCTION_INVOCATION_TIMEOUT page and quote-warmer.yml failed ~daily.
* admin-sync-fundamentals DID stop itself (~45 symbols in), but data-sync.yml
  stepped the offset by a fixed +500 anyway. The same ~225 symbols were
  refreshed nightly; the other 90% of the universe -- SBIN, TITAN, WIPRO
  included -- never were.

Neither was loud. Both ran "green" or "flaky" for weeks.
"""

import importlib.util
import json
import pathlib
import re
import sys
import time
import urllib.request

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
HANDLERS = ROOT / "handlers"
if str(HANDLERS) not in sys.path:
    sys.path.insert(0, str(HANDLERS))


def _load(stem):
    spec = importlib.util.spec_from_file_location(stem.replace("-", "_"), HANDLERS / f"{stem}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeClock:
    def __init__(self):
        self.now = 1_000_000.0

    def time(self):
        return self.now

    def sleep(self, s):
        self.now += s


@pytest.fixture
def clock(monkeypatch):
    c = FakeClock()
    monkeypatch.setattr(time, "time", c.time)
    monkeypatch.setattr(time, "sleep", c.sleep)
    return c


class _Resp:
    def __init__(self, body):
        self._b = body

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


# ---------------------------------------------------------------------------
# The budget constant must match what Vercel actually enforces.
# ---------------------------------------------------------------------------

def test_budget_matches_vercel_max_duration():
    import _budget

    cfg = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
    vercel_max = cfg["functions"]["api/*.py"]["maxDuration"]
    assert _budget.MAX_DURATION_S == vercel_max, (
        f"handlers/_budget.py MAX_DURATION_S={_budget.MAX_DURATION_S} but vercel.json "
        f"maxDuration={vercel_max}. Batch handlers will either overrun the platform "
        "limit or waste most of it."
    )
    b = _budget.Budget(t0=0, max_s=vercel_max)
    assert b.soft_s < b.hard_s < vercel_max


# ---------------------------------------------------------------------------
# admin-warm-quotes
# ---------------------------------------------------------------------------

def test_warmer_stops_at_budget_and_reports_next_offset(clock, monkeypatch):
    mod = _load("admin-warm-quotes")
    syms = [f"S{i}" for i in range(240)]
    monkeypatch.setattr(mod, "_tier_symbols", lambda tier: syms)
    timeouts = []

    def slow_urlopen(req, timeout=None):
        timeouts.append((clock.now, timeout))
        clock.now += 15  # every live-quote chunk takes 15s
        n = req.full_url.count("%2C") + 1
        return _Resp(json.dumps({"quotes": {f"x{i}": 1 for i in range(n)}}).encode())

    monkeypatch.setattr(urllib.request, "urlopen", slow_urlopen)
    out = mod._run("a", 0, 240)

    import _budget
    hard = _budget.MAX_DURATION_S * _budget.HARD_FRACTION
    assert out["durationMs"] / 1000 < _budget.MAX_DURATION_S
    assert out["attempted"] < 240, "budget should have cut this page short"
    assert out["nextOffset"] == out["attempted"]
    assert out["more"] is True
    t_start = timeouts[0][0]
    for started, to in timeouts:
        assert (started - t_start) + to <= hard + 1e-6, "a request was allowed to outlive the hard budget"


def test_warmer_workflow_follows_next_offset():
    wf = (ROOT / ".github" / "workflows" / "quote-warmer.yml").read_text(encoding="utf-8")
    assert "nextOffset" in wf, "quote-warmer.yml must resume from the handler's nextOffset"
    assert "offset=$(( offset + 240 ))" not in wf, "fixed +240 stepping skips whatever the budget cut"


# ---------------------------------------------------------------------------
# admin-sync-fundamentals
# ---------------------------------------------------------------------------

def test_fundamentals_uses_queue_records_attempts_and_stops(clock, monkeypatch):
    mod = _load("admin-sync-fundamentals")
    monkeypatch.setattr(mod, "SUPA_URL", "https://example.invalid")
    monkeypatch.setattr(mod, "SUPA_SRV", "srv")
    monkeypatch.setattr(mod, "warm_sid_cache", None)
    monkeypatch.setattr(mod, "get_sid_cache", None)
    queue = [f"Q{i}" for i in range(500)]
    monkeypatch.setattr(mod, "fetch_queue_symbols", lambda limit: queue[:limit])
    monkeypatch.setattr(mod, "fetch_active_symbols",
                        lambda **kw: pytest.fail("fallback used although the queue returned rows"))

    def fake_fetch(sym, **kw):
        clock.now += 1.0
        return {"market_cap": 1} if not sym.endswith("7") else {"error": "no data"}

    monkeypatch.setattr(mod, "fetch_fundamentals", fake_fetch)
    recorded = {}
    monkeypatch.setattr(mod, "record_attempts", lambda rows: recorded.update(rows) or len(rows))

    out = mod._run_sync(0, 500)
    assert out["source"] == "queue"
    assert 0 < out["processed"] < 500, "budget should stop the page well short of the limit"
    assert out["processed"] == out["success"] + out["failed"]
    assert len(recorded) == out["processed"], "every attempt, including failures, must be recorded"
    assert any(v is False for v in recorded.values()), "failed attempts must be recorded too"
    import _budget
    assert out["duration_ms"] / 1000 < _budget.MAX_DURATION_S


def test_fundamentals_fallback_next_offset_counts_processed(clock, monkeypatch):
    mod = _load("admin-sync-fundamentals")
    monkeypatch.setattr(mod, "SUPA_URL", "https://example.invalid")
    monkeypatch.setattr(mod, "SUPA_SRV", "srv")
    monkeypatch.setattr(mod, "warm_sid_cache", None)
    monkeypatch.setattr(mod, "get_sid_cache", None)
    monkeypatch.setattr(mod, "fetch_queue_symbols", lambda limit: [])
    monkeypatch.setattr(mod, "fetch_active_symbols", lambda offset, limit: [f"U{i}" for i in range(limit)])
    monkeypatch.setattr(mod, "record_attempts", lambda rows: len(rows))

    def fake_fetch(sym, **kw):
        clock.now += 1.0
        return {"market_cap": 1}

    monkeypatch.setattr(mod, "fetch_fundamentals", fake_fetch)
    out = mod._run_sync(1000, 500)
    assert out["source"] == "fallback"
    assert out["next_offset"] == 1000 + out["processed"], (
        "next_offset must advance by what was processed, not by the slice length"
    )


def test_data_sync_does_not_step_fixed_offsets():
    wf = (ROOT / ".github" / "workflows" / "data-sync.yml").read_text(encoding="utf-8")
    assert not re.search(r"^[ \t]*for offset in 0 500", wf, re.M), (
        "data-sync.yml is back to fixed +500 offsets -- that skipped ~90% of the universe"
    )
    assert ".processed" in wf


# ---------------------------------------------------------------------------
# perf-syntax.yml
# ---------------------------------------------------------------------------

def test_no_hashfiles_in_job_level_if():
    """hashFiles() in a job-level `if:` makes GitHub reject the whole file.
    perf-syntax.yml "failed" in 0s on every push for 4+ months that way."""
    for wf in (ROOT / ".github" / "workflows").glob("*.yml"):
        for m in re.finditer(r"^( {4})if:.*hashFiles", wf.read_text(encoding="utf-8"), re.M):
            pytest.fail(f"{wf.name}: hashFiles() in a job-level if: -- {m.group(0).strip()}")


# ---------------------------------------------------------------------------
# live-quote: one slow symbol must not fail or stall the whole batch
# ---------------------------------------------------------------------------

def test_yahoo_batch_returns_partial_results_on_timeout(monkeypatch):
    import threading

    mod = _load("live-quote")
    release = threading.Event()

    def fake_one(sym):
        if sym == "SLOW":
            release.wait(5)
            return {"symbol": sym}
        return {"symbol": sym}

    monkeypatch.setattr(mod, "fetch_yahoo_one", fake_one)
    monkeypatch.setattr(mod, "YAHOO_BATCH_TIMEOUT_S", 0.3)
    t = time.monotonic()
    try:
        out = mod.fetch_yahoo_batch(["A", "B", "SLOW", "C"])
    finally:
        release.set()
    took = time.monotonic() - t
    assert set(out) == {"A", "B", "C"}, "fast symbols must survive a slow one"
    assert took < 2, f"batch waited {took:.1f}s for a straggler instead of abandoning it"
