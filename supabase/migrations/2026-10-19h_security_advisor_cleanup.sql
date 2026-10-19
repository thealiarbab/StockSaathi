-- =============================================================================
-- Security advisor cleanup (19 Oct).
--
-- 1. Trigger functions and internal helpers were callable directly through
--    /rest/v1/rpc by anon and signed-in users. A trigger fires without the
--    caller needing EXECUTE, and the helpers are only called from inside
--    SECURITY DEFINER RPCs (which run as their owner), so nothing loses
--    access it uses.
-- 2. place_limit_order was callable signed out (it refused inside; it should
--    not be reachable at all).
-- 3. tmp_campaign_stats_2026_10 (the 17 Oct email campaign's stats) read
--    auth.users behind a token written into its own body. Service role only.
-- 4. Functions with no fixed search_path get one.
--
-- Left as they are, on purpose: get_shared_chat (public share pages),
-- signup_count (landing counter), profile_by_username (sign-in by username),
-- instrument_block_reason (stock pages, signed out too); RLS-enabled tables
-- with no policy are service-role-only by design. pg_net cannot be moved out
-- of public (the extension does not support it); moving pg_trgm would break
-- unqualified similarity() calls, so it stays.
-- No DROP / DELETE (the Supabase connector cannot run them).
-- =============================================================================

revoke execute on function public._mirror_user_notice() from public, anon, authenticated;
revoke execute on function public._notification_push() from public, anon, authenticated;
revoke execute on function public._notify_order_filled() from public, anon, authenticated;
revoke execute on function public._quote_not_live_reason(text) from public, anon, authenticated;
revoke execute on function public._mf_nav_from_date(text, timestamptz) from public, anon, authenticated;
revoke execute on function public.place_limit_order(text, text, numeric, bigint, text) from public, anon;
grant execute on function public.place_limit_order(text, text, numeric, bigint, text) to authenticated;
revoke execute on function public.tmp_campaign_stats_2026_10(text, uuid[]) from public, anon, authenticated;

alter function public._quote_cache_touch() set search_path = public;
alter function public._ist_quiet_hours() set search_path = public;
alter function public._order_label(text, numeric, text, text) set search_path = public;
alter function public.zz_ddl_probe() set search_path = public;
revoke execute on function public.zz_ddl_probe() from public, anon, authenticated;
alter function public.top_windows(interval, integer) set search_path = public;
alter function public.web_num(text) set search_path = public;
alter function public.web_path_group(text) set search_path = public;
