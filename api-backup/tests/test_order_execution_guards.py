"""Regression guards for server-side order execution.

WHY THIS FILE EXISTS
--------------------
Order execution was client-driven for months: `js/features/limitOrders.js`
polled inside the user's own browser tab and filled nothing unless the app was
open during NSE hours. For a product aimed at 13-18 year olds that window is
the school day, so orders simply rotted -- 75 pending, 42 already past their
fill condition, the oldest for 128 days, with users' cash reserved throughout.

Nothing about that failure was loud. No exception, no alert, no failing test.
It was found by reading customer-support chats months later.

These tests make the load-bearing pieces of the fix impossible to remove
silently. Each one maps to a specific way the bug could come back.
"""

import pathlib
import re

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]


def test_matcher_handler_exists():
    """The server-side matcher must exist at all."""
    assert (ROOT / "handlers" / "match-orders.py").is_file(), (
        "handlers/match-orders.py is gone. Without it nothing fills orders "
        "except the user's own browser tab -- the original bug."
    )


def test_matcher_route_registered():
    """An unregistered handler is a 404, i.e. silently no execution."""
    shim = (ROOT / "handlers" / "_shim.py").read_text(encoding="utf-8")
    assert '"match-orders": "match-orders"' in shim, (
        "match-orders is not in _shim.ROUTES, so /api/match-orders 404s and "
        "every scheduled tick is a no-op."
    )


def test_at_least_two_independent_schedulers():
    """One scheduler failing silently is what caused the outage. Keep two."""
    wrangler = (ROOT / "edge" / "front-door" / "wrangler.toml").read_text(encoding="utf-8")
    assert "[triggers]" in wrangler and "crons" in wrangler, (
        "The Cloudflare Worker cron trigger is gone -- that is the per-minute "
        "matcher tick."
    )

    workflow = ROOT / ".github" / "workflows" / "order-matcher.yml"
    assert workflow.is_file(), "The GitHub Actions backup scheduler is gone."
    text = workflow.read_text(encoding="utf-8")
    assert re.search(r"cron:\s*[\"']\*/\d+", text), (
        "order-matcher.yml no longer runs on a sub-hourly schedule."
    )


def test_worker_has_scheduled_handler():
    """A cron trigger with no scheduled() export fires into the void."""
    src = (ROOT / "edge" / "front-door" / "src" / "index.js").read_text(encoding="utf-8")
    assert "async scheduled(" in src, (
        "The Worker exports no scheduled() handler, so its cron trigger does "
        "nothing."
    )
    assert "match-orders" in src, "The Worker's cron no longer calls the matcher."


def test_client_matcher_never_auto_cancels():
    """The client used to cancel any order it could not price for ~2 minutes.

    getQuoteBatch has no mutual-fund coverage, so every MF order was
    guaranteed to trip that counter and be silently destroyed with a toast.
    A missing quote is our problem, not the user's order's problem.
    """
    src = (ROOT / "js" / "features" / "limitOrders.js").read_text(encoding="utf-8")
    assert "_NO_QUOTE_CANCEL_AFTER" not in src, (
        "The no-quote auto-cancel is back. It silently kills mutual-fund "
        "orders, which never have an intraday quote."
    )
    # cancelOrder must still be exported for the user-initiated path, but the
    # matcher loop itself must not call it.
    matcher = src[src.index("async function matchOnce"):]
    assert "cancelOrder(" not in matcher, (
        "matchOnce() cancels orders again. Only the user may cancel an order."
    )


def test_fill_rpc_has_service_role_path():
    """Execution must not depend on auth.uid(), i.e. on a logged-in browser."""
    migration = ROOT / "supabase" / "migrations" / "2026-09-13d_server_side_order_matcher.sql"
    assert migration.is_file(), "The server-side matcher migration is missing."
    sql = migration.read_text(encoding="utf-8")
    assert "admin_fill_limit_order" in sql
    assert "admin_pending_orders" in sql
    assert "grant execute on function public.admin_fill_limit_order" in sql.lower()
    # The core takes the owner from the row, so it must never be client-callable.
    assert re.search(
        r"revoke all on function public\._fill_limit_order_core.*from public, anon, authenticated",
        sql, re.I,
    ), (
        "_fill_limit_order_core is not revoked from authenticated. It takes "
        "the owner from the order row, so any signed-in user could fill "
        "anyone else's order."
    )


def test_matcher_does_not_cancel_unpriced_orders():
    """Server-side twin of the client guard above.

    Checked against CODE only -- the function's comments explain the old
    auto-cancel at length, and matching those would be a false positive.
    """
    src = (ROOT / "handlers" / "match-orders.py").read_text(encoding="utf-8")
    body = src.split("def run_match")[1].split("class handler")[0]
    code = "\n".join(
        line.split("#", 1)[0] for line in body.splitlines()
    ).lower()
    assert "cancel" not in code, (
        "run_match() cancels orders. It must only ever fill them; an order it "
        "cannot price should be retried next tick."
    )


def _js_holidays():
    src = (ROOT / "js" / "data" / "prices.js").read_text(encoding="utf-8")
    block = src.split("NSE_HOLIDAYS_2026 = new Set([")[1].split("]);")[0]
    return set(re.findall(r'"(\d{4}-\d{2}-\d{2})"', block))


def test_matcher_reads_holidays_from_prices_js():
    """One holiday list, not two.

    These began as separate hand-written copies and drifted by 8 dates within
    hours. The dangerous direction is a day the client calls a holiday and the
    matcher does not: the matcher then wakes on a closed exchange, pulls the
    previous session's stale closes, and fills live orders against them.
    """
    src = (ROOT / "handlers" / "match-orders.py").read_text(encoding="utf-8")
    assert "NSE_HOLIDAYS_2026 = new Set([" in src, (
        "The matcher no longer parses the holiday list out of prices.js. "
        "A second hand-maintained copy will drift."
    )


def test_holiday_fallback_matches_prices_js():
    """The embedded fallback is only used if parsing fails — keep it correct."""
    src = (ROOT / "handlers" / "match-orders.py").read_text(encoding="utf-8")
    block = src.split("_HOLIDAY_FALLBACK = {")[1].split("}")[0]
    fallback = set(re.findall(r'"(\d{4}-\d{2}-\d{2})"', block))
    js = _js_holidays()
    assert fallback == js, (
        "match-orders.py's _HOLIDAY_FALLBACK has drifted from prices.js.\n"
        f"  only in prices.js: {sorted(js - fallback)}\n"
        f"  only in fallback : {sorted(fallback - js)}"
    )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))


def test_pg_cron_schedules_the_matcher():
    """GitHub's */5 schedule really ran ~2x a day (measured 2026-09-21..25),
    so the punctual tick is pg_cron in the database. Don't lose it."""
    migs = sorted((ROOT / "supabase" / "migrations").glob("*.sql"))
    text = "\n".join(m.read_text(encoding="utf-8") for m in migs)
    assert re.search(r"cron\.schedule\(\s*'order-matcher'", text), (
        "No migration schedules 'order-matcher' with pg_cron. Without it the "
        "only tick is GitHub Actions, which drops most */5 runs."
    )
    assert "/api/match-orders" in text and "vault.decrypted_secrets" in text, (
        "The pg_cron matcher job must call /api/match-orders with the Vault secret."
    )
