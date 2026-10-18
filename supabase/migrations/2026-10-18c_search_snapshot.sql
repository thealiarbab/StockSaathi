-- =============================================================================
-- Search snapshot: one compact row per listed symbol so the Markets search box
-- can answer "under 100", "low budget", "best performing", "high dividend",
-- "bluechip banks" etc. instantly in the browser.
--
-- Served by /api/ai?op=search-snapshot, which the CDN caches for 6 hours, so
-- this runs a few times a day no matter how many students search.
--
-- Row: [symbol, last NSE close ₹ (null when NSE has no close for it), day %, 2-week %, market cap ₹ crore, P/E, dividend
--       yield %, ROE %, debt/equity (x), beta, 52w high ₹, 52w low ₹]
-- =============================================================================

create or replace function public.search_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with dates as (
  select trade_date, row_number() over (order by trade_date desc) as rn
    from (select distinct trade_date from nse_eod_prices) d
),
d0 as (select trade_date from dates where rn = 1),
d10 as (select trade_date from dates where rn = 11),
last as (
  select distinct on (e.symbol) e.symbol, e.close_paise, e.prev_close_paise
    from nse_eod_prices e, d0
   where e.trade_date = d0.trade_date
   order by e.symbol, (e.series = 'EQ') desc
),
back as (
  select distinct on (e.symbol) e.symbol, e.close_paise
    from nse_eod_prices e, d10
   where e.trade_date = d10.trade_date
   order by e.symbol, (e.series = 'EQ') desc
),
syms as (
  select symbol from last union select symbol from fundamentals_cache
)
select jsonb_build_object(
  'asOf', (select trade_date from d0),
  'cols', jsonb_build_array('s', 'p', 'd', 'r2w', 'mc', 'pe', 'dy', 'roe', 'de', 'b', 'hi', 'lo'),
  'rows', coalesce(jsonb_agg(jsonb_build_array(
      s.symbol,
      round((l.close_paise / 100.0)::numeric, 2),
      case when l.prev_close_paise > 0 then round((100.0 * (l.close_paise - l.prev_close_paise) / l.prev_close_paise)::numeric, 2) end,
      case when b.close_paise > 0 and l.close_paise > 0 then round((100.0 * (l.close_paise - b.close_paise) / b.close_paise)::numeric, 1) end,
      case when f.market_cap > 0 then round(f.market_cap / 1e7) end,
      case when f.pe_ratio > 0 and f.pe_ratio < 2000 then round(f.pe_ratio::numeric, 1) end,
      case when f.dividend_yield >= 0 and f.dividend_yield < 1 then round((f.dividend_yield * 100)::numeric, 2) end,
      case when f.roe is not null and abs(f.roe) < 10 then round((f.roe * 100)::numeric, 1) end,
      case when f.debt_to_equity >= 0 then round((f.debt_to_equity / 100)::numeric, 2) end,
      case when f.beta is not null then round(f.beta::numeric, 2) end,
      round(f.fifty_two_week_high::numeric, 2),
      round(f.fifty_two_week_low::numeric, 2)
    ) order by s.symbol), '[]'::jsonb)
)
from syms s
left join last l on l.symbol = s.symbol
left join back b on b.symbol = s.symbol
left join fundamentals_cache f on f.symbol = s.symbol;
$$;

revoke all on function public.search_snapshot() from public, anon, authenticated;
grant execute on function public.search_snapshot() to service_role;
