-- Applies 2026-04-25c_fundamentals_cache.sql, written in April and never run,
-- then closes two defects that only surfaced once it was live.
--
-- WHY IT MATTERED: handlers/fundamentals.py calls read_cache()/write_cache()
-- against fundamentals_cache. With the table absent both were silent no-ops,
-- so every /api/fundamentals request went upstream to Yahoo + Tickertape, and
-- handlers/screener.py fell back to the committed js/data/fundamentals_full.json
-- (generated 2026-04-26, 140 days stale).
--
-- DEFECT 1 -- default grants. Supabase grants anon/authenticated arwdDxtm on
-- every new public-schema table. The migration's `using (true)` SELECT policy
-- is the intended public read, but RLS does not govern TRUNCATE, so both roles
-- could have truncated the cache. Same hole as 2026-09-13e.
--
-- DEFECT 2 -- schema drift. write_cache() posts a debt_to_equity field the
-- April definition never had. PostgREST rejects the whole row with PGRST204
-- and write_cache is "best-effort, silent on failure", so every write was
-- dropped without a trace: after three live requests the table was still
-- empty. read_cache() uses select=*, so only the write path was affected.
--
-- Verified after applying: anon/authenticated sel=t, ins/upd/del/truncate=f;
-- service_role all true; and RELIANCE, 7NR and BMW all cached with
-- debt_to_equity populated.

create table if not exists public.fundamentals_cache (
  symbol               text primary key,
  name                 text,
  sector               text,
  industry             text,
  market_cap           numeric,
  pe_ratio             numeric,
  pe_ttm               numeric,
  pb_ratio             numeric,
  beta                 numeric,
  dividend_yield       numeric,
  eps                  numeric,
  roe                  numeric,
  debt_to_equity       numeric,
  fifty_two_week_high  numeric,
  fifty_two_week_low   numeric,
  fifty_day_avg        numeric,
  two_hundred_day_avg  numeric,
  source               text,
  cached_at_ms         bigint not null default (extract(epoch from now()) * 1000)::bigint,
  updated_at           timestamptz not null default now()
);
alter table public.fundamentals_cache add column if not exists debt_to_equity numeric;

alter table public.fundamentals_cache enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'fundamentals_cache_read') then
    create policy "fundamentals_cache_read" on public.fundamentals_cache
      for select using (true);
  end if;
end $$;

create index if not exists idx_fundamentals_cache_updated
  on public.fundamentals_cache (updated_at);
create index if not exists idx_fundamentals_cache_sector
  on public.fundamentals_cache (sector) where sector is not null;

create table if not exists public.tickertape_sids (
  symbol      text primary key,
  sid         text not null,
  resolved_at timestamptz not null default now()
);

alter table public.tickertape_sids enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tickertape_sids_read') then
    create policy "tickertape_sids_read" on public.tickertape_sids
      for select using (true);
  end if;
end $$;

revoke insert, update, delete, truncate on public.fundamentals_cache from anon, authenticated;
revoke insert, update, delete, truncate on public.tickertape_sids     from anon, authenticated;
