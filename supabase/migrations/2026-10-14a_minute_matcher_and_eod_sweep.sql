-- O7: the matcher ticked every 5 minutes, so a limit the price touched
-- briefly between ticks never filled (6 such BUYs, 5-12 Oct). Two fixes:
--  1. pg_cron job 2 runs every minute during market hours.
--  2. An end-of-day sweep: once NSE's bhavcopy for a session lands,
--     apply_nse_eod fills every pending LIMIT order placed before that
--     session's close whose limit lies inside the day's real low-high,
--     at the limit price. This is also how SME stocks with no live feed
--     get matched now that live matching refuses end-of-day prices.
--     Only the latest sessions are swept (not old dates re-ingested), so
--     this never back-fills historical touches.

drop function if exists public._fill_limit_order_core(uuid, bigint, boolean);
create or replace function public._fill_limit_order_core(
  p_order_id      uuid,
  p_market_paise  bigint,
  p_enforce_limit boolean default true,
  -- Honoured only when p_enforce_limit is false, which only the service
  -- role can request (fill_limit_order, the client path, always enforces).
  p_fill_at       bigint default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user_id       uuid;
  v_order_symbol  text;
  v_order_side    text;
  v_order_qty     numeric(18,6);
  v_limit_price   bigint;
  v_reserve       bigint;
  v_status        text;
  v_type          text;
  v_nav_from      date;
  v_nav_date      date;
  v_market        bigint;
  v_fill_price    bigint;
  v_fill_value    bigint;
  v_refund        bigint := 0;
  v_holding_id    uuid;
  v_holding_qty   numeric(18,6);
  v_holding_avg   bigint;
  v_new_qty       numeric(18,6);
  v_new_avg       bigint;
  v_txn_id        uuid;
  v_not_live      text;
begin
  select user_id, symbol, side, qty, limit_price_paise, reserved_cash, status, order_type, nav_from_date
    into v_user_id, v_order_symbol, v_order_side, v_order_qty,
         v_limit_price, v_reserve, v_status, v_type, v_nav_from
    from public.limit_orders
    where id = p_order_id
    for update;
  if not found then raise exception 'order not found'; end if;
  if v_status <> 'pending' then raise exception 'already %', v_status; end if;

  -- Server-side price. p_market_paise is not consulted.
  if v_type = 'MF' or v_order_symbol like 'MF\_%' then
    v_type := 'MF';
    select round(nav * 100)::bigint, nav_date into v_market, v_nav_date
      from public.mf_master
     where symbol = v_order_symbol and nav is not null and nav > 0;
  else
    select price_paise into v_market from public.quote_cache where symbol = v_order_symbol;
  end if;

  if v_market is null or v_market <= 0 then
    raise exception 'no price available for %, cannot fill', v_order_symbol;
  end if;

  if p_enforce_limit then
    if v_type = 'MF' then
      -- Allot only at the NAV for the day the order counts for.
      if v_nav_date is null or v_nav_date < coalesce(v_nav_from, v_nav_date) then
        raise exception 'nav not yet published for % (need % or later, have %)',
          v_order_symbol, v_nav_from, v_nav_date;
      end if;
    else
      -- A limit is only "touched" by a live price; yesterday's close is not one.
      -- Missing price = retry next tick (never cancel for it).
      v_not_live := public._quote_not_live_reason(v_order_symbol);
      if v_not_live is not null then
        raise exception 'no fresh price for % (%)', v_order_symbol, v_not_live;
      end if;
      if v_type = 'LIMIT' then
        if v_order_side = 'BUY'  and v_market > v_limit_price then
          raise exception 'market has not crossed limit (buy)';
        end if;
        if v_order_side = 'SELL' and v_market < v_limit_price then
          raise exception 'market has not crossed limit (sell)';
        end if;
      end if;
    end if;
  end if;

  if v_type in ('MF', 'AMO_MARKET') then
    v_fill_price := v_market;
  elsif v_order_side = 'BUY' then
    v_fill_price := least(v_limit_price, v_market);
  else
    v_fill_price := greatest(v_limit_price, v_market);
  end if;
  -- The end-of-day sweep fills at the limit price itself: the day's range
  -- proves the price was reached, not where between the ticks it traded.
  if p_fill_at is not null and not p_enforce_limit and v_type = 'LIMIT' then
    v_fill_price := p_fill_at;
  end if;
  -- A fund buy is a rupee amount: units = amount / NAV, to 4 decimals.
  if v_type = 'MF' and v_order_side = 'BUY' then
    v_order_qty := trunc(v_reserve::numeric / v_fill_price, 4);
    if v_order_qty <= 0 then raise exception 'amount too small for one unit fraction'; end if;
  end if;
  v_fill_value := round(v_order_qty * v_fill_price)::bigint;

  perform 1 from public.portfolios where user_id = v_user_id for update;

  if v_order_side = 'BUY' then
    v_refund := v_reserve - v_fill_value;
    if v_refund > 0 then
      update public.portfolios set cash_paise = cash_paise + v_refund, updated_at = now()
        where user_id = v_user_id;
    elsif v_refund < 0 then
      -- Only an order at the open can cost more than it reserved (a gap of
      -- more than 20%). Take the difference from free cash if it's there.
      update public.portfolios set cash_paise = cash_paise + v_refund, updated_at = now()
        where user_id = v_user_id and cash_paise >= -v_refund;
      if not found then raise exception 'reservation underflow'; end if;
    end if;

    select id, qty, avg_cost_paise
      into v_holding_id, v_holding_qty, v_holding_avg
      from public.holdings
      where user_id = v_user_id and symbol = v_order_symbol
      for update;
    if v_holding_id is not null then
      v_new_qty := v_holding_qty + v_order_qty;
      v_new_avg := round(((v_holding_avg::numeric * v_holding_qty) + v_fill_value) / v_new_qty)::bigint;
      update public.holdings set qty = v_new_qty, avg_cost_paise = v_new_avg, updated_at = now()
        where id = v_holding_id;
    else
      insert into public.holdings (user_id, symbol, qty, avg_cost_paise)
        values (v_user_id, v_order_symbol, v_order_qty, v_fill_price);
    end if;
  else
    select id, qty into v_holding_id, v_holding_qty
      from public.holdings
      where user_id = v_user_id and symbol = v_order_symbol
      for update;
    if v_holding_id is null or v_holding_qty < v_order_qty then
      -- The shares were sold some other way after this order was queued.
      -- Retrying can never succeed, so close the order and tell the user.
      update public.limit_orders
         set status = 'cancelled', cancelled_at = now(), cancel_reason = 'no_longer_held'
       where id = p_order_id;
      insert into public.user_notices (user_id, kind, title, body, payload)
        values (v_user_id, 'order_cancelled', 'Queued sell cancelled',
                format('Your queued sell of %s %s was cancelled because you now hold %s.',
                       trim_scale(v_order_qty), v_order_symbol, trim_scale(coalesce(v_holding_qty, 0))),
                jsonb_build_object('order_id', p_order_id, 'symbol', v_order_symbol,
                                   'qty', v_order_qty, 'held', coalesce(v_holding_qty, 0)));
      return jsonb_build_object('ok', false, 'cancelled', true, 'reason', 'no_longer_held',
                                'user_id', v_user_id);
    end if;
    v_new_qty := v_holding_qty - v_order_qty;
    if v_new_qty <= 1e-9 then
      delete from public.holdings where id = v_holding_id;
    else
      update public.holdings set qty = v_new_qty, updated_at = now() where id = v_holding_id;
    end if;
    update public.portfolios set cash_paise = cash_paise + v_fill_value, updated_at = now()
      where user_id = v_user_id;
  end if;

  insert into public.transactions (user_id, symbol, side, qty, price_paise, value_paise, bias_flags, idempotency_key)
    values (v_user_id, v_order_symbol, v_order_side, v_order_qty, v_fill_price, v_fill_value,
            jsonb_build_array(jsonb_build_object('bias','limit_order_filled','order_id',p_order_id,'order_type',v_type)),
            'limit_' || p_order_id::text)
    returning id into v_txn_id;

  update public.limit_orders
    set status = 'filled', filled_at = now(),
        filled_price_paise = v_fill_price, filled_txn_id = v_txn_id,
        qty = v_order_qty
    where id = p_order_id;

  return jsonb_build_object('ok', true, 'fill_price', v_fill_price, 'qty', v_order_qty,
                            'order_type', v_type, 'txn_id', v_txn_id, 'user_id', v_user_id);
end;
$function$;

revoke execute on function public._fill_limit_order_core(uuid, bigint, boolean, bigint) from public, anon, authenticated;
grant execute on function public._fill_limit_order_core(uuid, bigint, boolean, bigint) to service_role;

create or replace function public.admin_eod_sweep(p_trade_date date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  o record;
  r jsonb;
  n_filled int := 0;
  n_failed int := 0;
  v_close timestamptz := (p_trade_date + time '15:30') at time zone 'Asia/Kolkata';
begin
  if p_trade_date < (now() at time zone 'Asia/Kolkata')::date - 3 then
    return jsonb_build_object('ok', true, 'skipped', 'old_session', 'trade_date', p_trade_date);
  end if;
  for o in
    select lo.id, lo.limit_price_paise
      from public.limit_orders lo
      join public.nse_eod_prices e on e.symbol = lo.symbol and e.trade_date = p_trade_date
     where lo.status = 'pending' and lo.order_type = 'LIMIT'
       and lo.created_at < v_close
       and e.low_paise > 0 and e.high_paise > 0
       and ((lo.side = 'BUY'  and e.low_paise  <= lo.limit_price_paise)
         or (lo.side = 'SELL' and e.high_paise >= lo.limit_price_paise))
     order by lo.created_at
  loop
    begin
      r := public._fill_limit_order_core(o.id, o.limit_price_paise, false, o.limit_price_paise);
      if (r->>'ok')::boolean then
        n_filled := n_filled + 1;
        update public.transactions
           set bias_flags = bias_flags || jsonb_build_array(jsonb_build_object('via', 'eod_sweep', 'session', p_trade_date))
         where id = (r->>'txn_id')::uuid;
      end if;
    exception when others then
      n_failed := n_failed + 1;
      raise warning 'eod sweep: order % failed: %', o.id, SQLERRM;
    end;
  end loop;
  return jsonb_build_object('ok', true, 'trade_date', p_trade_date, 'filled', n_filled, 'failed', n_failed);
end;
$function$;
revoke all on function public.admin_eod_sweep(date) from public, anon, authenticated;

select cron.alter_job(2, schedule := '* 3-10 * * 1-5');

-- apply_nse_eod runs the sweep after each ingest.
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
  v_added int; v_refreshed int; v_prev_fixed int; v_divergent jsonb; v_sweep jsonb;
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

  -- Limit orders this session's real range reached (see admin_eod_sweep).
  v_sweep := public.admin_eod_sweep(p_trade_date);

  return jsonb_build_object('ok', true, 'trade_date', p_trade_date,
    'added', v_added, 'refreshed', v_refreshed, 'prev_close_fixed', v_prev_fixed, 'eod_sweep', v_sweep,
    'divergent_count', jsonb_array_length(v_divergent), 'divergent', v_divergent);
end;
$function$;
