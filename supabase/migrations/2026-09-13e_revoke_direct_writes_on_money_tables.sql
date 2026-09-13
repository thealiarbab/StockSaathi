-- =============================================================================
-- 2026-09-13e — Make the money tables read-only to clients.
--
-- WHY
-- ---
-- 2026-09-12b stopped `apply_trade` trusting a client-supplied price. That fix
-- is worth nothing while the client can skip `apply_trade` entirely and POST
-- straight at the table:
--
--     POST /rest/v1/holdings
--     Authorization: Bearer <any logged-in user's JWT>
--     {"user_id":"<self>","symbol":"MRF","qty":999999999999,"avg_cost_paise":0}
--
-- Two gates should have stopped that, and neither does:
--
--  1. RLS. `holdings_self_all` is `FOR ALL USING (auth.uid() = user_id)`.
--     That is an OWNERSHIP test, not an AUTHORSHIP test — it asks "is this row
--     yours", never "did a legitimate code path write it". A row you mint for
--     yourself passes. Same shape on `portfolios` (so cash_paise is writable),
--     `limit_orders`, and — via `txn_self_insert` — `transactions`.
--
--  2. Table grants. Supabase's project template runs
--       alter default privileges in schema public grant all on tables
--         to anon, authenticated;
--     so every table created in `public` hands INSERT/UPDATE/DELETE/TRUNCATE to
--     both roles on creation. Before this migration the only table-level revoke
--     in the whole project was one `revoke select on public.leaderboard_view`
--     (2026-09-12a). Everything else still carries the default grant.
--
-- Note on provenance: the qty = 999999999999 / avg_cost_paise = 0 rows on the
-- `admin` account that prompted this review did NOT come through this hole.
-- Checked live 2026-09-13 — each has a matching `transactions` row with
-- price_paise = 0, so they went through `apply_trade` back when it still
-- trusted the client's price, and were created as proof-of-concept during the
-- 2026-09-12b audit. This migration is therefore closing a real but so-far
-- unexploited door, not the one those rows came through.
--
-- Live grant check on 2026-09-13 confirmed every table in `public` still
-- carries INSERT/UPDATE/DELETE for BOTH `anon` and `authenticated`.
-- Exploitability is decided by the RLS policy on top:
--   holdings / portfolios / limit_orders -> FOR ALL  => writable, this is the hole
--   transactions / transfers             -> INSERT   => forgeable history
--   portfolio_history                    -> SELECT   => already safe
-- The revokes below make the grant layer agree with the intent either way.
--
-- WHAT THIS CHANGES
-- -----------------
-- SELECT is untouched everywhere — the app reads all six of these tables
-- directly and must keep doing so (js/db/sync.js:116-147, 132).
--
-- Verified by grep over js/ that the client issues NO insert/update/upsert/
-- delete against any of the six. Its entire direct-write surface is:
--     watchlist      upsert + delete   (js/db/sync.js:244)
--     coach_messages insert            (js/db/sync.js:267)
--     friends        delete            (js/db/sync.js:302)
--     profiles       update            (js/auth/accounts.js:534,580)
--     user_notices   update (ack)      (js/components/noticeModal.js)
-- none of which are touched here.
--
-- The RPCs keep working: SECURITY DEFINER executes as the function owner, so
-- revoking from `authenticated` does not affect what `apply_trade` can write.
-- The service_role key bypasses both RLS and these grants, so the order
-- matcher, the snapshot job, and the admin panel are unaffected.
--
-- NOTE: unlike function grants (see STATUS.md §2.4), table privileges ARE held
-- directly by anon/authenticated rather than inherited from PUBLIC, so
-- `revoke ... from anon, authenticated` is effective here. PUBLIC is included
-- anyway so this does not depend on that distinction being true. Verify with
-- the has_table_privilege query at the bottom rather than trusting success.
-- =============================================================================

-- ---- 1. Money tables: SELECT only for clients -------------------------------
revoke insert, update, delete, truncate on
  public.holdings,
  public.transactions,
  public.portfolios,
  public.limit_orders,
  public.transfers,
  public.portfolio_history
from public, anon, authenticated;

-- Re-assert the reads the app depends on, in case a blanket revoke ever runs
-- ahead of this file.
grant select on
  public.holdings,
  public.transactions,
  public.portfolios,
  public.limit_orders,
  public.transfers,
  public.portfolio_history
to authenticated;

-- ---- 2. Drop the now-misleading write policies -------------------------------
-- With the grants gone these policies are unreachable, but leaving a FOR ALL
-- policy in place documents an intent that is no longer true and would silently
-- re-open the hole the moment someone re-grants. Replace each with an explicit
-- read-only policy that says what it means.
drop policy if exists "holdings_self_all"   on public.holdings;
create policy "holdings_self_read" on public.holdings for select
  using (auth.uid() = user_id);

drop policy if exists "portfolios_self_all" on public.portfolios;
create policy "portfolios_self_read" on public.portfolios for select
  using (auth.uid() = user_id);

drop policy if exists "orders_self_all"     on public.limit_orders;
create policy "orders_self_read" on public.limit_orders for select
  using (auth.uid() = user_id);

-- `transactions` never had a write-all policy, but txn_self_insert let a client
-- fabricate trade history that never moved cash. The ledger is written by
-- apply_trade alone.
drop policy if exists "txn_self_insert" on public.transactions;

-- Same for transfers: apply_transfer / redeem_transfer_code are the writers.
-- Verified no client path inserts transfers directly (nothing in js/ touches
-- the table at all), and both RPCs are SECURITY DEFINER so they are unaffected.
drop policy if exists "transfers_sender_insert" on public.transfers;

-- ---- 2b. Price sources: defence in depth ------------------------------------
-- Verified live 2026-09-13: quote_cache, mf_master and dhan_instruments each
-- have RLS on with a SELECT-only policy, so the write grants below are
-- currently INERT — no client can poison them today. Revoked anyway, because
-- `apply_trade` and `_fill_limit_order_core` now derive every execution price
-- from these tables. One added policy or one `enable row level security`
-- omission would turn the price source into the new attack surface, and that
-- would silently undo both 2026-09-12b and 2026-09-13f.
revoke insert, update, delete, truncate on
  public.quote_cache,
  public.mf_master,
  public.dhan_instruments
from public, anon, authenticated;

-- ---- 3. Verification --------------------------------------------------------
-- Run this AFTER applying. Every row must come back f/f/f. A `t` means the
-- revoke did not take and the hole is still open.
--
--   select t.relname,
--          has_table_privilege('authenticated', t.oid, 'INSERT') auth_insert,
--          has_table_privilege('authenticated', t.oid, 'UPDATE') auth_update,
--          has_table_privilege('authenticated', t.oid, 'DELETE') auth_delete,
--          has_table_privilege('authenticated', t.oid, 'SELECT') auth_select
--     from pg_class t join pg_namespace n on n.oid = t.relnamespace
--    where n.nspname = 'public'
--      and t.relname in ('holdings','transactions','portfolios',
--                        'limit_orders','transfers','portfolio_history')
--    order by 1;
--   -- expect: auth_select = t, the other three = f, on all six rows.
--
-- End-to-end check with a real logged-in JWT (not the service key):
--   POST /rest/v1/holdings {"user_id":"<self>","symbol":"TEST","qty":1,
--                           "avg_cost_paise":0}      -> expect 401/403
--   POST /rest/v1/rpc/apply_trade {...}              -> expect 200 (still works)

-- ---- 4. NOT done here, deliberately -----------------------------------------
-- The default privilege that caused this is still in place, so the NEXT table
-- created in `public` will again be born client-writable. The durable fix is:
--
--   alter default privileges in schema public
--     revoke insert, update, delete on tables from anon, authenticated;
--
-- That is left out of this migration because it changes the behaviour of
-- tables that do not exist yet, which is the owner's call and not a
-- containment action. Decide separately.
--
-- The bad rows themselves are NOT touched here. Closing the write path and
-- correcting the data are separate decisions; see the investigation notes.
