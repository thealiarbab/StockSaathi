-- 2026-09-13a — Remove objects that nothing calls.
--
-- leaderboard() + leaderboard_view: the feature was removed from the product
-- in Apr 2026 (js/router.js:10, js/components/nav.js:28) and schema.sql:810
-- instructs the reader to drop them, but they never were. No caller exists
-- anywhere in the codebase. Revoked in 2026-09-12a/d; this removes them.
-- Until that revoke they were anon-executable and returned minors' school
-- names alongside portfolio values.
--
-- public_profiles: a view superseded by search_public_profiles(). No caller.
--
-- NOT dropped, deliberately, after checking each one:
--   pg_trgm relocation — the extension backs a live GIN index
--                        (idx_dhan_name_trgm on dhan_instruments).
--   quote_cache purge  — 2,089 rows are >7d old, but as of 2026-09-12b
--                        apply_trade refuses to price a symbol with no cache
--                        row, so purging would make those untradeable. It is
--                        no longer merely a cache.

drop view if exists public.leaderboard_view;
drop function if exists public.leaderboard(integer, text);
drop view if exists public.public_profiles;
