-- =============================================================================
-- 2026-09-12a — Close anonymous read access to minors' schools and balances.
--
-- Two SECURITY DEFINER functions were executable by the `anon` role with no
-- auth.uid() check, so a signed-out caller holding only the publishable anon
-- key (served openly by GET /api/config) could read them:
--
--   search_public_profiles(text)  → id, username, display_name, SCHOOL,
--                                   avatar_color. Walk 2-char prefixes and you
--                                   have a name → school map of 13-18 y/os.
--
--   leaderboard(int, text)        → the above PLUS portfolio_value_paise,
--                                   return_bps, trades — and it carries
--                                   SET row_security TO 'off', so RLS does not
--                                   apply. p_school filters to one school,
--                                   turning it into a ranked roster of minors.
--
-- Approach: REVOKE rather than CREATE OR REPLACE. The live function bodies have
-- drifted from supabase/schema.sql (no migration history exists — see the audit
-- brief, item #10) and pg_trgm is installed, suggesting the search body may have
-- been extended in place. Replacing bodies from schema.sql risks silently
-- reverting that. Revoking EXECUTE closes the identical hole, touches no logic,
-- and is one GRANT away from reversal.
-- =============================================================================

-- --------------------------------------------------------------------------
-- 1a. search_public_profiles — friend/transfer search.
-- Sole caller is searchUsers() in js/features/transfers.js:334, reached only
-- from the logged-in friends + transfers flows. That call site already catches
-- RPC failure and falls back to listAccountsPublic(), so revocation degrades
-- gracefully even on an unexpected signed-out hit.
--
-- NOT touched: profile_by_username(text). It is called from registerAccount()
-- in js/auth/accounts.js:90 BEFORE a session exists, to catch duplicate
-- usernames at signup. Guarding it would silently break that check. It returns
-- no school and is exact-match only.
-- --------------------------------------------------------------------------
revoke execute on function public.search_public_profiles(text) from anon;

-- --------------------------------------------------------------------------
-- 1b. leaderboard — dead code that never stopped serving.
-- js/router.js:10 and js/components/nav.js:28 both record the leaderboard as
-- "fully removed Apr 24 2026 — no route, no nav, no helper", and
-- supabase/schema.sql:810 instructs the reader to drop it. It was never
-- dropped. No frontend calls it (admin.js's renderLeaderboard is a local
-- helper over /api/ai data, unrelated to this RPC).
--
-- Revoked, not dropped: a DROP is irreversible and the product may want the
-- feature back. This closes the exposure today and leaves that call to Ali.
-- --------------------------------------------------------------------------
revoke execute on function public.leaderboard(integer, text) from anon, authenticated;

-- --------------------------------------------------------------------------
-- Audit brief #5 — leaderboard_view is flagged ERROR by the Supabase advisor
-- (security_definer_view). It wraps leaderboard(200, NULL) and projects
-- `school` straight through, inheriting both the definer semantics and the
-- row_security bypass. Revoke direct reads and flip it to invoker semantics so
-- the advisor clears and RLS applies to anyone who is re-granted later.
-- --------------------------------------------------------------------------
revoke select on public.leaderboard_view from anon, authenticated;
alter view public.leaderboard_view set (security_invoker = true);
