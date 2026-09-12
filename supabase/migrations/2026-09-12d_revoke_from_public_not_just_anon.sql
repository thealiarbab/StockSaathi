-- =============================================================================
-- 2026-09-12d — Corrects 2026-09-12a and 2026-09-12c.
--
-- Those two migrations said "revoke execute ... from anon". That was a no-op.
-- Postgres grants EXECUTE to PUBLIC on every newly created function, and the
-- anon role inherits that PUBLIC grant rather than holding a direct one of its
-- own. Revoking from a role that never had a direct grant succeeds, reports
-- success, and changes nothing.
--
-- Both migrations returned {"success": true}. Verification afterwards showed
-- anon could still execute all 17 functions, including search_public_profiles
-- and leaderboard. If the grant check had not been run, the exposure would
-- still be open and would have been reported as fixed.
--
-- Correct form: revoke from PUBLIC, then explicitly re-grant to the roles that
-- legitimately need access.
--
-- Verified after applying, as an unauthenticated caller using the site's own
-- publishable anon key from GET /api/config:
--   POST /rest/v1/rpc/search_public_profiles -> 401 permission denied
--   POST /rest/v1/rpc/leaderboard            -> 401 permission denied
--   POST /rest/v1/rpc/profile_by_username    -> 200 []   (signup path intact)
-- =============================================================================

-- ---- 1a. Friend/transfer search: authenticated only -------------------------
-- Sole caller is searchUsers() in js/features/transfers.js:334, a logged-in
-- flow that already falls back to listAccountsPublic() if the RPC fails.
revoke execute on function public.search_public_profiles(text) from public, anon;
grant  execute on function public.search_public_profiles(text) to authenticated;

-- ---- 1b. Leaderboard: nobody ------------------------------------------------
-- Removed from the product in Apr 2026 (js/router.js:10, js/components/nav.js:28)
-- but never dropped. No caller anywhere in the codebase — admin.js's
-- renderLeaderboard is a local helper over /api/ai data, unrelated to this RPC.
-- Revoked rather than dropped so the decision stays reversible.
revoke execute on function public.leaderboard(integer, text) from public, anon, authenticated;

-- ---- 9. Money-moving RPCs: authenticated only -------------------------------
-- Not currently exploitable by anon (each bails when auth.uid() is null), but
-- the whole protection lives inside each function body. One refactor that
-- forgets the guard would turn a money-moving verb into an open endpoint.
revoke execute on function
  public.apply_trade(text, text, numeric, bigint, text, jsonb),
  public.apply_transfer(text, bigint, text),
  public.apply_transfer(text, bigint, text, text),
  public.place_limit_order(text, text, numeric, bigint),
  public.cancel_limit_order(uuid),
  public.fill_limit_order(uuid, bigint),
  public.create_transfer_code(bigint, text, text),
  public.redeem_transfer_code(text),
  public.reset_my_portfolio(),
  public.add_friend_by_username(text),
  public.list_my_friends(),
  public.list_my_transfers(integer)
from public, anon;

grant execute on function
  public.apply_trade(text, text, numeric, bigint, text, jsonb),
  public.apply_transfer(text, bigint, text),
  public.apply_transfer(text, bigint, text, text),
  public.place_limit_order(text, text, numeric, bigint),
  public.cancel_limit_order(uuid),
  public.fill_limit_order(uuid, bigint),
  public.create_transfer_code(bigint, text, text),
  public.redeem_transfer_code(text),
  public.reset_my_portfolio(),
  public.add_friend_by_username(text),
  public.list_my_friends(),
  public.list_my_transfers(integer)
to authenticated;

-- ---- Trigger functions: reachable by nobody over PostgREST ------------------
revoke execute on function
  public.handle_new_user(),
  public.on_transaction_insert_snapshot()
from public, anon, authenticated;

-- profile_by_username is intentionally left anon-executable: registerAccount()
-- (js/auth/accounts.js:90) calls it BEFORE a session exists to catch duplicate
-- usernames at signup. Guarding it would silently break that check. It returns
-- no school and is exact-match only.
--
-- NOTE for anyone applying 2026-09-12b (or any other CREATE OR REPLACE) after
-- this file: CREATE OR REPLACE preserves existing grants, so it does not undo
-- the revokes above. That was verified explicitly after 12b was applied — but
-- verify it again rather than assuming.
