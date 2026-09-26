-- =============================================================================
-- 2026-09-27c  NSE end-of-day bhavcopy: a second, official price source
--
-- WHY
--
-- Yahoo was the ONLY price source (AGENTS.md), and on 2026-09-26 it was found
-- failing in two ways nothing detected:
--   * ten NSE SME stocks had a meta price frozen at 2024-07-23 (AILIMITED Rs 94
--     vs Rs 15.60 real); users bought at up to 6x and one limit order filled
--     956 shares at the fake price;
--   * new NSE SME listings (ADISOFT, APSISAERO...) have no Yahoo listing at
--     all, so the browser showed an invented price and users ordered at it.
--
-- NSE's own daily bhavcopy covers every listed stock including SME (series
-- SM/ST: 464 of 3,654 rows on 2026-09-25) and cross-checked exactly against
-- the corrected Yahoo prices (GIRIRAJ 67.25, NIDAN 13.30, RELIANCE 1226.00).
-- NSE blocks Vercel but not GitHub runners, so .github/workflows/nse-eod.yml
-- downloads it and posts it to /api/admin-ingest-eod, which stores it here
-- and calls apply_nse_eod().
--
-- apply_nse_eod never overrides a live price. It only
--   1. adds a quote_cache row for a stock that has none, and
--   2. replaces a row whose price is from before that trading day,
-- and it RETURNS every stock where a same-day Yahoo price disagrees with the
-- exchange's close by more than 15% — the check that would have caught the
-- frozen-price bug on its first day.
-- =============================================================================

create table if not exists public.nse_eod_prices (
  symbol       text not null,
  trade_date   date not null,
  series       text not null,
  open_paise   bigint,
  high_paise   bigint,
  low_paise    bigint,
  close_paise  bigint not null,
  prev_close_paise bigint,
  volume       bigint,
  ingested_at  timestamptz not null default now(),
  primary key (symbol, trade_date)
);
alter table public.nse_eod_prices enable row level security;
revoke all on table public.nse_eod_prices from anon, authenticated;

create or replace function public.apply_nse_eod(p_trade_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- 15:30 IST close = 10:00 UTC.
  v_close_ms bigint := (extract(epoch from (p_trade_date::timestamp + time '10:00') at time zone 'UTC') * 1000)::bigint;
  -- A price is "from before that trading day" if older than its 09:15 IST open.
  v_open_ms  bigint := (extract(epoch from (p_trade_date::timestamp + time '03:45') at time zone 'UTC') * 1000)::bigint;
  v_added int; v_refreshed int; v_divergent jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'symbol', q.symbol, 'yahoo', q.price_paise / 100.0, 'nse_close', e.close_paise / 100.0,
           'ratio', round(q.price_paise::numeric / e.close_paise, 2)) order by q.symbol), '[]'::jsonb)
    into v_divergent
    from public.quote_cache q
    join public.nse_eod_prices e on e.symbol = q.symbol and e.trade_date = p_trade_date
   where q.source <> 'nse_eod' and q.ts_ms >= v_open_ms and e.close_paise > 0
     and abs(q.price_paise - e.close_paise)::numeric / e.close_paise > 0.15;

  with src as (
    select e.* from public.nse_eod_prices e
     where e.trade_date = p_trade_date and e.close_paise > 0
       and e.series in ('EQ','BE','BZ','SM','ST')
  ), ins as (
    insert into public.quote_cache
      (symbol, price_paise, prev_close_paise, day_high_paise, day_low_paise, volume, change_pct,
       ts_ms, source, updated_at, cached_at_ms)
    select s.symbol, s.close_paise, s.prev_close_paise, s.high_paise, s.low_paise, coalesce(s.volume, 0),
           case when s.prev_close_paise > 0 then (s.close_paise - s.prev_close_paise)::float8 / s.prev_close_paise else 0 end,
           v_close_ms, 'nse_eod', now(), (extract(epoch from now()) * 1000)::bigint
      from src s
    on conflict (symbol) do update set
      price_paise = excluded.price_paise, prev_close_paise = excluded.prev_close_paise,
      day_high_paise = excluded.day_high_paise, day_low_paise = excluded.day_low_paise,
      volume = excluded.volume, change_pct = excluded.change_pct, ts_ms = excluded.ts_ms,
      source = excluded.source, updated_at = excluded.updated_at, cached_at_ms = excluded.cached_at_ms
    where public.quote_cache.ts_ms is null or public.quote_cache.ts_ms < v_open_ms
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_added, v_refreshed from ins;

  return jsonb_build_object('ok', true, 'trade_date', p_trade_date,
    'added', v_added, 'refreshed', v_refreshed,
    'divergent_count', jsonb_array_length(v_divergent), 'divergent', v_divergent);
end;
$$;

revoke all on function public.apply_nse_eod(date) from public, anon, authenticated;
grant execute on function public.apply_nse_eod(date) to service_role;
