-- O3: Yahoo rows for the ingested session keep their own previous close,
-- which was two sessions old whenever Yahoo left a bar empty (13 Oct: 77%
-- of quotes). After the bhavcopy lands, overwrite prev_close_paise and
-- change_pct on those rows with the exchange's figure. The live price is
-- untouched.
create or replace function public.apply_nse_eod(p_trade_date date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_close_ms bigint := (extract(epoch from (p_trade_date::timestamp + time '10:00') at time zone 'UTC') * 1000)::bigint;
  v_open_ms  bigint := (extract(epoch from (p_trade_date::timestamp + time '03:45') at time zone 'UTC') * 1000)::bigint;
  v_next_ms  bigint := (extract(epoch from ((p_trade_date + 1)::timestamp + time '03:45') at time zone 'UTC') * 1000)::bigint;
  v_added int; v_refreshed int; v_prev_fixed int; v_divergent jsonb;
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

  -- Live rows priced during this session: official previous close.
  update public.quote_cache q
     set prev_close_paise = e.prev_close_paise,
         change_pct = (q.price_paise - e.prev_close_paise)::float8 / e.prev_close_paise
    from public.nse_eod_prices e
   where e.symbol = q.symbol and e.trade_date = p_trade_date
     and q.source <> 'nse_eod' and q.ts_ms >= v_open_ms and q.ts_ms < v_next_ms
     and e.prev_close_paise > 0 and q.prev_close_paise is distinct from e.prev_close_paise;
  get diagnostics v_prev_fixed = row_count;

  return jsonb_build_object('ok', true, 'trade_date', p_trade_date,
    'added', v_added, 'refreshed', v_refreshed, 'prev_close_fixed', v_prev_fixed,
    'divergent_count', jsonb_array_length(v_divergent), 'divergent', v_divergent);
end;
$function$;
