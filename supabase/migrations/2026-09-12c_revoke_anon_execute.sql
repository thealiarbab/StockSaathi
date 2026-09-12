-- =============================================================================
-- 2026-09-12c — Audit brief #9. Defence in depth on the money-moving RPCs.
--
-- These SECURITY DEFINER functions are executable by `anon`. They are not
-- currently exploitable: each derives the actor from auth.uid() and bails when
-- it is null, so an anonymous call is inert. The problem is that the entire
-- protection lives inside each function body. One refactor that forgets the
-- guard turns a money-moving verb into an open endpoint, and nothing outside
-- the function would catch it.
--
-- Postgres already knows the caller is anonymous. Let it enforce that.
--
-- NOT revoked, deliberately:
--   profile_by_username(text)  — called by registerAccount() in
--     js/auth/accounts.js:90 BEFORE a session exists, to catch duplicate
--     usernames at signup. Revoking breaks that check silently. Returns no
--     school and is exact-match only.
--   search_public_profiles(text) — handled in migration 2026-09-12a.
-- =============================================================================

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
from anon;

-- Trigger functions that should never have been reachable over PostgREST at
-- all. They are invoked by the triggers that own them, not by clients.
revoke execute on function
  public.handle_new_user(),
  public.on_transaction_insert_snapshot()
from anon, authenticated;
