-- =============================================================================
-- BSE end-of-day closes for BSE-only stocks, and the search snapshot using them.
--
-- WHY: ~1,180 of the stocks in js/data/universeFull.json are listed only on BSE.
-- The nightly import (nse-eod.yml) only reads NSE's bhavcopy, so those stocks
-- had no stored exchange close: they were left out of price searches ("under
-- ₹100") and had no list chart. .github/workflows/bse-eod.yml now downloads
-- BSE's official daily bhavcopy on a GitHub runner, keeps only our BSE-only
-- stocks (matched by BSE scrip code), and posts them to /api/admin-ingest-eod
-- with "exchange": "BSE". Real exchange closes only, never an estimate.
--
-- Server-only table: nothing in the browser reads it directly.
-- =============================================================================

create table if not exists public.bse_eod_prices (
  symbol           text not null,          -- our universe symbol
  trade_date       date not null,
  scrip_code       integer not null,       -- BSE FinInstrmId
  bse_group        text,                   -- A, B, T, X, XT, M, MT, P, ...
  open_paise       bigint,
  high_paise       bigint,
  low_paise        bigint,
  close_paise      bigint not null,
  prev_close_paise bigint,
  volume           bigint,
  ingested_at      timestamptz not null default now(),
  primary key (symbol, trade_date)
);
alter table public.bse_eod_prices enable row level security;
revoke all on table public.bse_eod_prices from anon, authenticated;

-- -----------------------------------------------------------------------------
-- search_snapshot(): NSE closes, plus BSE closes for symbols NSE doesn't list.
-- Only the last 15 trading days are read (the price tables are never pruned,
-- so an unbounded read would grow every month).
-- A stock's price is its latest close in the last 30 days; day % only when
-- that close is from the latest trading day.
-- -----------------------------------------------------------------------------
create or replace function public.search_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with nse as (
  select symbol, trade_date, close_paise, prev_close_paise, series
    from nse_eod_prices
   where series in ('EQ', 'BE', 'BZ', 'SM', 'ST') and close_paise > 0
     and trade_date > current_date - 45
),
dates as (
  select trade_date, row_number() over (order by trade_date desc) as rn
    from (select distinct trade_date from nse) d
),
d0 as (select trade_date from dates where rn = 1),
d10 as (select trade_date from dates where rn = 11),
d14 as (select coalesce((select trade_date from dates where rn = 15), (select min(trade_date) from dates)) as trade_date),
eod as (
  select symbol, trade_date, close_paise, prev_close_paise, (series = 'EQ') as pref from nse
  union all
  select b.symbol, b.trade_date, b.close_paise, b.prev_close_paise, false
    from bse_eod_prices b
   where b.close_paise > 0 and b.trade_date > current_date - 45
     and not exists (select 1 from nse n where n.symbol = b.symbol)
),
daily as (
  select distinct on (e.symbol, e.trade_date) e.*
    from eod e, d14
   where e.trade_date >= d14.trade_date
   order by e.symbol, e.trade_date, e.pref desc
),
last as (
  select distinct on (symbol) symbol, trade_date, close_paise, prev_close_paise
    from daily
   order by symbol, trade_date desc
),
back as (
  select d.symbol, d.close_paise from daily d, d10 where d.trade_date = d10.trade_date
),
-- Last ~3 weeks of real closes per symbol, squeezed to a 36-level shape
-- (one 0-9a-z character per day) for the little charts on the Markets list.
shape as (
  select symbol,
         string_agg(substr('0123456789abcdefghijklmnopqrstuvwxyz',
                           (case when hi = lo then 18 else round(35.0 * (close_paise - lo) / (hi - lo))::int end) + 1, 1), '' order by trade_date) as sk
    from (select d.*, min(close_paise) over (partition by symbol) lo, max(close_paise) over (partition by symbol) hi from daily d) x
   group by symbol having count(*) >= 2
),
-- fundamentals_cache has rows that carry another company's numbers under a
-- stray ticker (FINANCE holds Bajaj Finance's, ANGEL holds Angel One's).
-- Keep a row only if the stock's own close sits inside (half to 1.5x) the
-- 52-week range on file, or, with no close, if no other ticker has the
-- identical market value or the identical 52-week high and low (STL carried
-- Nestle's, DRA carried Kotak's).
fund as (
  select f.*,
         coalesce(case
           when l.close_paise is not null
             then l.close_paise / 100.0 between f.fifty_two_week_low * 0.5 and f.fifty_two_week_high * 1.5
           else not exists (select 1 from fundamentals_cache g
                             where g.symbol <> f.symbol
                               and (g.market_cap = f.market_cap
                                    or (g.fifty_two_week_high = f.fifty_two_week_high and g.fifty_two_week_low = f.fifty_two_week_low)))
         end, true) as ok
    from fundamentals_cache f
    left join last l on l.symbol = f.symbol
),
syms as (
  select symbol from last
  union
  select symbol from fund where ok and symbol !~ '[.]' and market_cap > 0
)
select jsonb_build_object(
  'asOf', (select trade_date from d0),
  'cols', jsonb_build_array('s', 'p', 'd', 'r2w', 'mc', 'pe', 'dy', 'roe', 'de', 'b', 'hi', 'lo', 'sk'),
  'rows', coalesce(jsonb_agg(jsonb_build_array(
      s.symbol,
      round((l.close_paise / 100.0)::numeric, 2),
      case when l.trade_date = (select trade_date from d0) and l.prev_close_paise > 0
           then round((100.0 * (l.close_paise - l.prev_close_paise) / l.prev_close_paise)::numeric, 2) end,
      case when b.close_paise > 0 and l.close_paise > 0 then round((100.0 * (l.close_paise - b.close_paise) / b.close_paise)::numeric, 1) end,
      case when f.market_cap > 0 then round(f.market_cap / 1e7) end,
      case when f.pe_ratio > 0 and f.pe_ratio < 2000 then round(f.pe_ratio::numeric, 1) end,
      case when f.dividend_yield >= 0 and f.dividend_yield < 1 then round((f.dividend_yield * 100)::numeric, 2) end,
      case when f.roe is not null and abs(f.roe) < 10 then round((f.roe * 100)::numeric, 1) end,
      case when f.debt_to_equity >= 0 then round((f.debt_to_equity / 100)::numeric, 2) end,
      case when f.beta is not null then round(f.beta::numeric, 2) end,
      round(f.fifty_two_week_high::numeric, 2),
      round(f.fifty_two_week_low::numeric, 2),
      sh.sk
    ) order by s.symbol), '[]'::jsonb)
)
from syms s
left join last l on l.symbol = s.symbol
left join back b on b.symbol = s.symbol
left join fund f on f.symbol = s.symbol and f.ok
left join shape sh on sh.symbol = s.symbol;
$$;

revoke all on function public.search_snapshot() from public, anon, authenticated;
grant execute on function public.search_snapshot() to service_role;
