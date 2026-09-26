-- Fundamentals refresh: stalest-first queue instead of fixed offsets.
--
-- WHY
-- admin-sync-fundamentals processes ~1 symbol/s and bails at its time budget
-- after ~45 symbols, but data-sync.yml stepped the offset by a fixed +500.
-- Every night refreshed the same five slices (0-50, 500-545, 1000-1051,
-- 1500-1542, 2000-2036) and never touched the other ~90% of 4,457 active
-- equities; nothing past offset 2,500 was ever even requested. Page 0 sorts
-- Nifty 50 first, which is why exactly the six Nifty-50 banks had a P/E and
-- the other 38 did not. Measured 2026-09-26: fundamentals_cache = 540 rows.
--
-- A queue ordered by staleness cannot skip anything: whatever a page fails to
-- reach is still the stalest next page, and next night.
--
-- fundamentals_sync_attempts records every attempt, successful or not. Without
-- it a symbol with no upstream data never gets a fundamentals_cache row, stays
-- "stalest" forever, and wedges the head of the queue.

create table if not exists public.fundamentals_sync_attempts (
  symbol       text primary key,
  attempted_at timestamptz not null default now(),
  ok           boolean
);

alter table public.fundamentals_sync_attempts enable row level security;
-- Service role only. No policies; also strip Supabase's default grants so
-- anon/authenticated cannot TRUNCATE (which bypasses RLS).
revoke all on table public.fundamentals_sync_attempts from anon, authenticated;

create or replace function public.fundamentals_refresh_queue(p_limit int default 50)
returns table (symbol text)
language sql
stable
security definer
set search_path = public
as $$
  select d.symbol
  from public.dhan_instruments d
  left join public.fundamentals_cache f on f.symbol = d.symbol
  left join public.fundamentals_sync_attempts a on a.symbol = d.symbol
  where d.is_active and d.kind = 'EQUITY'
  order by greatest(
             coalesce(f.cached_at_ms, 0),
             coalesce((extract(epoch from a.attempted_at) * 1000)::bigint, 0)
           ) asc,
           d.prominence desc nulls last,
           d.symbol asc
  limit least(greatest(coalesce(p_limit, 50), 1), 1000);
$$;

revoke all on function public.fundamentals_refresh_queue(int) from public, anon, authenticated;
grant execute on function public.fundamentals_refresh_queue(int) to service_role;

-- fundamentals_cache.updated_at was only ever set by its insert default, so an
-- upsert left it at first-insert time and made fresh rows look weeks old.
-- write_cache now sends it explicitly; this backfills from cached_at_ms.
update public.fundamentals_cache
   set updated_at = to_timestamp(cached_at_ms / 1000.0)
 where cached_at_ms is not null
   and updated_at < to_timestamp(cached_at_ms / 1000.0);
