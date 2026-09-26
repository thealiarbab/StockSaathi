"""Shared wall-clock budget for handlers that do batch work.

Vercel kills the function at vercel.json's `maxDuration` and returns an HTML
FUNCTION_INVOCATION_TIMEOUT page instead of our JSON. Everything done before
that is kept (rows already upserted stay upserted) but the caller never learns
how far we got, so it cannot resume. That is how admin-warm-quotes failed daily
and how admin-sync-fundamentals quietly skipped ~90% of the universe.

So batch handlers must stop themselves first and report where they stopped.
MAX_DURATION_S must equal vercel.json's functions."api/*.py".maxDuration;
api-backup/tests/test_batch_budgets.py enforces that.
"""

import time

MAX_DURATION_S = 60

# Stop STARTING new work after this fraction of the budget. Whatever unit of
# work is in flight still has to finish (or time out) inside the remainder.
SOFT_FRACTION = 0.6
# No in-flight request may be allowed to run past this — leaves time to
# serialise the response before the platform kills us.
HARD_FRACTION = 0.87


class Budget:
    def __init__(self, t0=None, max_s=None):
        self.t0 = time.time() if t0 is None else t0
        total = MAX_DURATION_S if max_s is None else max_s
        self.soft_s = total * SOFT_FRACTION
        self.hard_s = total * HARD_FRACTION

    def elapsed(self):
        return time.time() - self.t0

    def can_start(self):
        """True while it is still safe to begin another unit of work."""
        return self.elapsed() < self.soft_s

    def timeout(self, cap):
        """Per-request timeout: `cap`, shrunk so it cannot outlive the hard budget."""
        return max(1.0, min(float(cap), self.hard_s - self.elapsed()))
