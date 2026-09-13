"""Regression guards for server-side trade pricing.

WHY THIS FILE EXISTS
--------------------
Execution prices used to be whatever the browser said they were. A logged-in
user could POST to /rest/v1/rpc/apply_trade with p_price_paise = 1, buy 100000
RELIANCE for a rupee, and sell it back at the real price. `fill_limit_order`
was the same shape: the "has the market crossed the limit" test validated
p_market_paise, a number the caller chose, so the order authorised its own
fill and then named its price.

Migration 2026-09-12b fixed both by pricing from `public.quote_cache`.

IT DID NOT STAY FIXED. Twenty-four hours later, 2026-09-13d refactored the
fill path into a shared `_fill_limit_order_core` so the new server-side
matcher and the client could use one body -- and wrote that body from the
PRE-12b version. The quote_cache lookup vanished and p_market_paise went back
to driving both the crossing gate and the fill price. Nothing failed. The
refactor was reviewed as a feature change, and the hole was open again until
it was found by reading the live function source on 2026-09-13.

That is the failure mode these tests exist to catch: not someone deliberately
removing a security check, but someone rewriting a function body from an old
copy and losing it. Each test asserts that the NEWEST definition of a
money-moving function in supabase/migrations/ still prices server-side.

These are static file checks -- CI has no database. They guard the repo, which
is what regressed. Verify the live database separately with:

    select proname, prosrc like '%quote_cache%'
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and proname in ('apply_trade', '_fill_limit_order_core');
"""

import pathlib
import re

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "supabase" / "migrations"

CREATE_RE = "create or replace function public.{name}"


def _latest_definition(func_name):
    """Return (filename, body) for the most recent definition of func_name.

    Migrations are applied in filename order, so the last file that defines a
    function is the one that wins in the database. Only that definition
    matters -- an older file still containing the fix proves nothing.
    """
    needle = CREATE_RE.format(name=func_name)
    found = []
    for path in sorted(MIGRATIONS.glob("*.sql")):
        text = path.read_text(encoding="utf-8").lower()
        idx = text.rfind(needle)
        if idx != -1:
            found.append((path.name, text[idx:]))
    if not found:
        pytest.fail(
            f"No migration defines {func_name}. Either it was renamed or the "
            f"migration was applied by hand and never committed -- both of "
            f"which put the repo out of step with production."
        )
    name, tail = found[-1]
    # Cut at the next function definition so we only inspect this body.
    nxt = tail.find("create or replace function", len(needle))
    return name, (tail[:nxt] if nxt != -1 else tail)


@pytest.mark.parametrize("func", ["apply_trade", "_fill_limit_order_core"])
def test_latest_definition_prices_from_quote_cache(func):
    """The newest definition of each trade RPC must read the server's price."""
    fname, body = _latest_definition(func)
    assert "quote_cache" in body, (
        f"{func} is defined in {fname} without reading public.quote_cache. "
        f"That is exactly how 2026-09-13d silently reverted 2026-09-12b: the "
        f"body was rewritten from an older copy and the price lookup was lost. "
        f"The execution price must come from the server, never from the caller."
    )


def test_fill_core_ignores_client_market_price():
    """p_market_paise may be accepted for compatibility, never acted on.

    It is kept in the signature because the deployed frontend and the matcher
    both still pass it. The moment it is read again, the caller is back in
    control of both the crossing test and the fill price.
    """
    fname, body = _latest_definition("_fill_limit_order_core")
    offenders = [
        line.strip()
        for line in body.splitlines()
        if "p_market_paise" in line
        and not line.strip().startswith("--")
        and "p_market_paise  bigint" not in line  # the parameter declaration
    ]
    assert not offenders, (
        f"_fill_limit_order_core in {fname} still uses p_market_paise:\n  "
        + "\n  ".join(offenders)
        + "\nThat value is supplied by the caller. Use the price read from "
        "quote_cache (falling back to mf_master) instead."
    )


def test_apply_trade_never_books_the_client_price():
    """apply_trade must book v_ref_price, never the caller's p_price_paise.

    2026-09-12b clamped p_price_paise only when it was >10% off the reference
    and honored it within that band. That gave a crafted request the favorable
    edge of a 10% window on every trade (buy at ref-10%, sell at ref+10%,
    ~+22% per round-trip, compounding). 2026-09-13j removed the band: the
    booked price is always the server's, and p_price_paise is advisory only.

    The client price must never be assigned to the variable that sets the
    trade value. Any `:= p_price_paise` (assigning it to the booked price) or a
    reintroduced tolerance band is the exploit coming back.
    """
    fname, body = _latest_definition("apply_trade")

    assert "v_price    := v_ref_price" in body or "v_price := v_ref_price" in body, (
        f"apply_trade in {fname} does not unconditionally set the booked price "
        f"to v_ref_price. The execution price must always be the server's."
    )

    offenders = [
        line.strip()
        for line in body.splitlines()
        if re.search(r"v_price\s*:=\s*p_price_paise", line)
        and not line.strip().startswith("--")
    ]
    assert not offenders, (
        f"apply_trade in {fname} assigns the client price to the booked price:\n  "
        + "\n  ".join(offenders)
        + "\np_price_paise is advisory only. Book v_ref_price."
    )

    # The +/-10% tolerance band was the vehicle. It must not return.
    assert "v_band" not in body, (
        f"apply_trade in {fname} reintroduces a tolerance band (v_band). "
        f"Honoring the client price within any band is the exploitable edge; "
        f"there is no safe band width. Book v_ref_price unconditionally."
    )


def test_fill_core_has_mutual_fund_fallback():
    """Pricing MF orders from quote_cache alone would freeze them forever.

    quote_cache has no mutual-fund coverage; the matcher prices MF_* from
    mf_master (handlers/match-orders.py). A fix that requires a quote_cache row
    makes every MF limit order permanently unfillable -- the same class of bug
    as the old client destroying MF orders it could not price.
    """
    fname, body = _latest_definition("_fill_limit_order_core")
    assert "mf_master" in body, (
        f"_fill_limit_order_core in {fname} has no mf_master fallback, so every "
        f"mutual-fund order will fail to price and can never fill."
    )


def test_fill_core_not_callable_by_clients():
    """The core takes its owner from the order row, not auth.uid().

    If it is reachable over PostgREST, any logged-in user can fill anyone
    else's order by passing that order's id.
    """
    fname, body = _latest_definition("_fill_limit_order_core")
    joined = " ".join(body.split())
    assert re.search(
        r"revoke execute on function public\._fill_limit_order_core"
        r"\s*\([^)]*\)\s*from[^;]*authenticated",
        joined,
    ), (
        f"{fname} does not revoke execute on _fill_limit_order_core from "
        f"authenticated. It resolves the owner from the order row, so an "
        f"exposed core lets any user fill any order."
    )


def test_money_tables_are_not_client_writable():
    """holdings/portfolios/limit_orders must not be writable over PostgREST.

    Supabase's default privileges grant INSERT/UPDATE/DELETE on every table in
    `public` to anon and authenticated. Combined with a `for all` ownership
    policy, that let a client write holdings and cash directly -- bypassing
    apply_trade entirely and making the pricing fixes above irrelevant.
    """
    texts = {
        p.name: p.read_text(encoding="utf-8").lower()
        for p in sorted(MIGRATIONS.glob("*.sql"))
    }
    revokes = [
        name
        for name, text in texts.items()
        if "revoke insert, update, delete, truncate on" in text
        and "public.holdings" in text
        and "authenticated" in text
    ]
    assert revokes, (
        "No migration revokes write privileges on public.holdings from "
        "authenticated. Without that revoke a logged-in client can POST "
        "holdings and cash straight to PostgREST, and server-side pricing in "
        "apply_trade protects nothing."
    )

    # A `for all` policy re-grants the write path through RLS even if the
    # table grants are correct, so neither may come back.
    for table in ("holdings", "portfolios", "limit_orders"):
        latest_policy = None
        for name, text in texts.items():
            if re.search(rf'create policy "[a-z_]+" on public\.{table} for all', text):
                latest_policy = name
        assert latest_policy is None or latest_policy < max(revokes), (
            f"{latest_policy} creates a `for all` policy on public.{table} "
            f"after the write grants were revoked. Ownership is not "
            f"authorship: `for all using (auth.uid() = user_id)` lets a user "
            f"mint their own rows."
        )
