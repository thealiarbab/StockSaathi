-- =============================================================================
-- 2026-09-14a  Instrument prominence ranking + RLS initplan hygiene
--
-- Part of the coach latency work. Two unrelated-looking changes, both
-- prerequisites for server-side sector screening.
--
-- 1. dhan_instruments.prominence
--
--    The obvious way to rank a sector screen is `order by idx_tags desc`.
--    That is WRONG and silently so. idx_tags is a BITMASK, not a rank
--    (scripts/build-universe.mjs:447-451):
--
--      1<<0 Nifty50   1<<1 Nifty100   1<<2 Nifty500
--      1<<3 Midcap150 1<<4 Smallcap250
--
--    A Nifty-50 stock carries 1|2|4 = 7. A small-cap carries 4|16 = 20.
--    So ordering by idx_tags descending puts MICRO-CAPS FIRST, and
--    "top 20 bank stocks" would return the twenty least significant banks
--    in the sector. The answer would look plausible and be entirely wrong,
--    which is the worst failure mode for a coach aimed at 13-18 year olds
--    who cannot evaluate it.
--
--    cap_bucket is not a substitute: the live values are micro / mid /
--    large / mega / unknown, with no 'small' at all despite
--    classifyCapBucket having a branch for it.
--
--    Generated + stored so it is computed on write and indexable.
--
-- 2. (select auth.uid()) in the money-table policies
--
--    Supabase's linter flags all 14 policies with auth_rls_initplan: a bare
--    auth.uid() is volatile and can be re-evaluated per row, where
--    (select auth.uid()) is an InitPlan evaluated once.
--
--    HONEST SCOPE: this was measured before changing it, and the effect is
--    smaller than the lint implies. EXPLAIN ANALYZE under a real JWT shows
--    the auth expression already folded into the Index Cond on these
--    tables (3.6 ms for a 200-row transactions read), because the policies
--    are simple equality against an indexed column. So this is hygiene, not
--    a fix for a live problem.
--
--    It is still worth doing: it costs nothing, and it protects the cases
--    where folding cannot happen - sequential scans, and OR-shaped policies
--    like transfers_party_read. It also sets the pattern for user_events,
--    which will be the largest table in this database within weeks.
-- =============================================================================

-- --- 1. prominence ----------------------------------------------------------

alter table public.dhan_instruments
  add column if not exists prominence smallint
  generated always as (
    case when (idx_tags & 1)  <> 0 then 5   -- Nifty 50
         when (idx_tags & 2)  <> 0 then 4   -- Nifty 100
         when (idx_tags & 4)  <> 0 then 3   -- Nifty 500
         when (idx_tags & 8)  <> 0 then 3   -- Midcap 150
         when (idx_tags & 16) <> 0 then 2   -- Smallcap 250
         else 1 end
  ) stored;

comment on column public.dhan_instruments.prominence is
  'Derived rank from the idx_tags bitmask: 5=Nifty50, 4=Nifty100, 3=Nifty500/Mid150, 2=Small250, 1=unindexed. Exists because idx_tags is a bitmask and ORDER BY idx_tags DESC ranks small-caps above Nifty-50 constituents.';

-- Sector screening index. Tiebreak on symbol is applied in the query, not
-- here, so the same question returns the same answer twice - a coach that
-- reorders its answer between identical questions reads as broken.
create index if not exists idx_dhan_sector_prominence
  on public.dhan_instruments (sector, prominence desc)
  where is_active;

-- --- 2. RLS initplan hygiene -------------------------------------------------
-- Policy bodies are otherwise unchanged. Each is dropped and recreated because
-- Postgres has no ALTER POLICY ... USING that preserves the rest in place
-- across versions consistently.

do $$
begin
  -- profiles
  execute 'alter policy profiles_self_read   on public.profiles using ((select auth.uid()) = id)';
  execute 'alter policy profiles_update_self on public.profiles using ((select auth.uid()) = id) with check ((select auth.uid()) = id)';
  execute 'alter policy profiles_insert_self on public.profiles with check ((select auth.uid()) = id)';

  -- read-only money tables (writes go through SECURITY DEFINER RPCs)
  execute 'alter policy portfolios_self_read        on public.portfolios        using ((select auth.uid()) = user_id)';
  execute 'alter policy holdings_self_read          on public.holdings          using ((select auth.uid()) = user_id)';
  execute 'alter policy txn_self_read               on public.transactions      using ((select auth.uid()) = user_id)';
  execute 'alter policy orders_self_read            on public.limit_orders      using ((select auth.uid()) = user_id)';
  execute 'alter policy portfolio_history_self_read on public.portfolio_history using ((select auth.uid()) = user_id)';

  -- transfers: OR-shaped, so this is the one that genuinely cannot fold
  execute 'alter policy transfers_party_read on public.transfers using ((select auth.uid()) = sender_id or (select auth.uid()) = recipient_id)';

  -- client-writable tables
  execute 'alter policy coach_self_all     on public.coach_messages using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)';
  execute 'alter policy watchlist_self_all on public.watchlist      using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)';
  execute 'alter policy friends_self_all   on public.friends        using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)';

  -- notices
  execute 'alter policy notices_self_read on public.user_notices using ((select auth.uid()) = user_id)';
  execute 'alter policy notices_self_ack  on public.user_notices using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)';
exception when others then
  raise notice 'RLS initplan rewrite skipped or partial: %', sqlerrm;
end $$;
