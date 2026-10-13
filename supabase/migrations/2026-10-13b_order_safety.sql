-- Order safety: O2 (stale prices), O6 (overselling), O9 (absurd limits).
--
-- O2  apply_trade and the limit matcher booked whatever quote_cache held, with
--     no age check. For stocks Yahoo can't price that row is the nightly
--     nse_eod close, i.e. YESTERDAY's price, so 24 trades in 21 days were
--     booked outside the day's real high-low (ARABIAN, AATMAJ, AAKAAR, ...).
--     A price is now "live" only if it is not an EOD row, was fetched in the
--     last 5 minutes, and is from a trade made today after 09:15 IST.
--     apply_trade also refuses outside 09:15-15:30 IST (the app routes those
--     hours to after-market orders already). The holiday case needs no list:
--     nothing trades on a holiday, so no quote carries today's date.
-- O6  a market SELL ignored shares already promised to a queued SELL, so a
--     queued order could sell shares the user no longer held and then fail
--     on every matcher tick forever (dx.6376: SELL 15 queued, holding 3).
--     apply_trade now counts queued sells; the fill core cancels such an
--     order with a notice instead of raising forever.
-- O9  place_limit_order accepted any price (Rs 1 limits; a BUY at 13x the
--     market holding Rs 5,644 back). Equity limits must now be within 20% of
--     the last price, the widest NSE price band.

alter table public.limit_orders
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_reason text;

-- Live = traded today (IST) after the open, fetched in the last 5 minutes,
-- not an end-of-day row. Returns null when live, else a user-facing reason.
create or replace function public._quote_not_live_reason(p_symbol text)
 returns text
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_src text; v_ts bigint; v_cached bigint;
  v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  v_open_ms bigint := (extract(epoch from
      ((now() at time zone 'Asia/Kolkata')::date + time '09:15') at time zone 'Asia/Kolkata') * 1000)::bigint;
begin
  select source, ts_ms, cached_at_ms into v_src, v_ts, v_cached
    from public.quote_cache where symbol = p_symbol;
  if not found then return 'no price'; end if;
  if v_src = 'nse_eod' then return 'only the exchange''s previous close is available'; end if;
  if coalesce(v_ts, 0) < v_open_ms then return 'it has not traded yet today'; end if;
  if coalesce(v_cached, 0) < v_now_ms - 5 * 60 * 1000 then return 'the price is more than 5 minutes old'; end if;
  return null;
end;
$function$;

create or replace function public.apply_trade(p_symbol text, p_side text, p_qty numeric, p_price_paise bigint, p_idempotency_key text, p_bias_flags jsonb default '[]'::jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user_id      uuid := auth.uid();
  v_ref_price    bigint;
  v_price        bigint;
  v_adjusted     boolean := false;
  v_value        bigint;
  v_existing_id  uuid;
  v_existing_px  bigint;
  v_holding_id   uuid;
  v_holding_qty  numeric(18,6);
  v_holding_avg  bigint;
  v_new_qty      numeric(18,6);
  v_new_avg      bigint;
  v_txn_id       uuid;
  v_committed    numeric(18,6);
  v_not_live     text;
  v_ist          timestamp := now() at time zone 'Asia/Kolkata';
begin
  if v_user_id is null then raise exception 'not logged in'; end if;
  if p_side not in ('BUY','SELL') then raise exception 'invalid side: %', p_side; end if;
  if p_qty <= 0 then raise exception 'qty must be positive'; end if;

  if p_idempotency_key is not null then
    select id, price_paise into v_existing_id, v_existing_px
      from public.transactions
      where user_id = v_user_id and idempotency_key = p_idempotency_key
      limit 1;
    if v_existing_id is not null then
      return jsonb_build_object('ok', true, 'txn_id', v_existing_id, 'idempotent', true,
                                'price_paise', v_existing_px,
                                'price_adjusted', (v_existing_px is distinct from p_price_paise));
    end if;
  end if;

  if extract(isodow from v_ist) > 5
     or v_ist::time < time '09:15' or v_ist::time >= time '15:30' then
    raise exception 'The market is closed. Place an after-market order instead.';
  end if;

  select price_paise into v_ref_price
    from public.quote_cache where symbol = p_symbol;
  if v_ref_price is null or v_ref_price <= 0 then
    raise exception 'no price available for %', p_symbol;
  end if;
  v_not_live := public._quote_not_live_reason(p_symbol);
  if v_not_live is not null then
    raise exception 'No live price for % right now (%). Use a limit order instead.', p_symbol, v_not_live;
  end if;

  -- ALWAYS the server price. p_price_paise is only what the UI displayed;
  -- v_adjusted tells the client when the two differed.
  v_price    := v_ref_price;
  v_adjusted := (p_price_paise is distinct from v_ref_price);

  v_value := round(p_qty * v_price)::bigint;

  perform 1 from public.portfolios where user_id = v_user_id for update;

  if p_side = 'BUY' then
    update public.portfolios
      set cash_paise = cash_paise - v_value, updated_at = now()
      where user_id = v_user_id and cash_paise >= v_value;
    if not found then raise exception 'insufficient cash'; end if;

    select id, qty, avg_cost_paise
      into v_holding_id, v_holding_qty, v_holding_avg
      from public.holdings
      where user_id = v_user_id and symbol = p_symbol
      for update;

    if v_holding_id is not null then
      v_new_qty := v_holding_qty + p_qty;
      v_new_avg := round(((v_holding_avg::numeric * v_holding_qty) + v_value) / v_new_qty)::bigint;
      update public.holdings set qty = v_new_qty, avg_cost_paise = v_new_avg, updated_at = now()
        where id = v_holding_id;
    else
      insert into public.holdings (user_id, symbol, qty, avg_cost_paise)
        values (v_user_id, p_symbol, p_qty, v_price);
    end if;
  else
    select id, qty
      into v_holding_id, v_holding_qty
      from public.holdings
      where user_id = v_user_id and symbol = p_symbol
      for update;

    if v_holding_id is null or v_holding_qty < p_qty then
      raise exception 'insufficient holding';
    end if;
    select coalesce(sum(qty), 0) into v_committed
      from public.limit_orders
     where user_id = v_user_id and symbol = p_symbol and side = 'SELL' and status = 'pending';
    if v_holding_qty - v_committed < p_qty then
      raise exception 'You hold % but % are already queued to sell. Cancel that order first.',
        trim_scale(v_holding_qty), trim_scale(v_committed);
    end if;
    v_new_qty := v_holding_qty - p_qty;
    if v_new_qty <= 1e-9 then
      delete from public.holdings where id = v_holding_id;
    else
      update public.holdings set qty = v_new_qty, updated_at = now() where id = v_holding_id;
    end if;
    update public.portfolios set cash_paise = cash_paise + v_value, updated_at = now()
      where user_id = v_user_id;
  end if;

  insert into public.transactions (user_id, symbol, side, qty, price_paise, value_paise, bias_flags, idempotency_key)
    values (v_user_id, p_symbol, p_side, p_qty, v_price, v_value, p_bias_flags, p_idempotency_key)
    returning id into v_txn_id;

  return jsonb_build_object('ok', true, 'txn_id', v_txn_id,
                            'price_paise', v_price,
                            'price_adjusted', v_adjusted);
end;
$function$;

create or replace function public.place_limit_order(p_symbol text, p_side text, p_qty numeric, p_limit_price_paise bigint)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user_id      uuid := auth.uid();
  v_reserve      bigint := round(p_qty * p_limit_price_paise)::bigint;
  v_holding_qty  numeric(18,6);
  v_committed    numeric(18,6);
  v_order_id     uuid;
  v_ref          bigint;
begin
  if v_user_id is null then raise exception 'not logged in'; end if;
  if p_side not in ('BUY','SELL') then raise exception 'invalid side'; end if;
  if p_qty <= 0 or p_limit_price_paise <= 0 then raise exception 'qty and price must be positive'; end if;

  if not exists (select 1 from public.quote_cache where symbol = p_symbol and price_paise > 0)
     and not exists (select 1 from public.mf_master where symbol = p_symbol and nav > 0) then
    raise exception 'no live price for % yet, so it cannot be traded right now', p_symbol;
  end if;

  -- Price band: within 20% of the last known price (equities only).
  if p_symbol not like 'MF\_%' then
    select price_paise into v_ref from public.quote_cache where symbol = p_symbol and price_paise > 0;
    if v_ref is null then
      select close_paise into v_ref from public.nse_eod_prices
       where symbol = p_symbol and close_paise > 0 order by trade_date desc limit 1;
    end if;
    if v_ref is not null and (p_limit_price_paise < round(v_ref * 0.8) or p_limit_price_paise > round(v_ref * 1.2)) then
      raise exception 'Limit must be within 20%% of the last price (₹% – ₹%).',
        to_char(round(v_ref * 0.8) / 100.0, 'FM99999990.00'),
        to_char(round(v_ref * 1.2) / 100.0, 'FM99999990.00');
    end if;
  end if;

  if p_side = 'BUY' then
    update public.portfolios set cash_paise = cash_paise - v_reserve, updated_at = now()
      where user_id = v_user_id and cash_paise >= v_reserve;
    if not found then raise exception 'insufficient cash'; end if;
  else
    select qty into v_holding_qty from public.holdings
      where user_id = v_user_id and symbol = p_symbol
      for update;
    if v_holding_qty is null then
      raise exception 'insufficient holding';
    end if;
    select coalesce(sum(qty), 0) into v_committed
      from public.limit_orders
     where user_id = v_user_id and symbol = p_symbol
       and side = 'SELL' and status = 'pending';
    if (v_committed + p_qty) > v_holding_qty then
      raise exception 'You hold % but % are already queued to sell. Cancel that order first.',
        trim_scale(v_holding_qty), trim_scale(v_committed);
    end if;
  end if;

  insert into public.limit_orders (user_id, symbol, side, qty, limit_price_paise, reserved_cash)
    values (v_user_id, p_symbol, p_side, p_qty, p_limit_price_paise,
            case when p_side = 'BUY' then v_reserve else 0 end)
    returning id into v_order_id;

  return jsonb_build_object('ok', true, 'order_id', v_order_id);
end;
$function$;

create or replace function public.cancel_limit_order(p_order_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user_id   uuid := auth.uid();
  v_order_side   text;
  v_reserve      bigint;
  v_status       text;
begin
  if v_user_id is null then raise exception 'not logged in'; end if;
  select side, reserved_cash, status
    into v_order_side, v_reserve, v_status
    from public.limit_orders
    where id = p_order_id and user_id = v_user_id
    for update;
  if not found then raise exception 'order not found'; end if;
  if v_status <> 'pending' then raise exception 'order already %', v_status; end if;

  update public.limit_orders
     set status = 'cancelled', cancelled_at = now(), cancel_reason = 'user'
   where id = p_order_id;
  if v_order_side = 'BUY' and v_reserve > 0 then
    update public.portfolios set cash_paise = cash_paise + v_reserve, updated_at = now()
      where user_id = v_user_id;
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function public._fill_limit_order_core(p_order_id uuid, p_market_paise bigint, p_enforce_limit boolean default true)
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
  v_from_cache    boolean := false;
  v_not_live      text;
begin
  select user_id, symbol, side, qty, limit_price_paise, reserved_cash, status
    into v_user_id, v_order_symbol, v_order_side, v_order_qty,
         v_limit_price, v_reserve, v_status
    from public.limit_orders
    where id = p_order_id
    for update;
  if not found then raise exception 'order not found'; end if;
  if v_status <> 'pending' then raise exception 'already %', v_status; end if;

  -- Server-side price. p_market_paise is not consulted.
  select price_paise into v_market
    from public.quote_cache where symbol = v_order_symbol;
  v_from_cache := v_market is not null;

  if v_market is null then
    select round(nav * 100)::bigint into v_market
      from public.mf_master
      where symbol = v_order_symbol and nav is not null and nav > 0;
  end if;

  if v_market is null or v_market <= 0 then
    raise exception 'no price available for %, cannot fill', v_order_symbol;
  end if;

  if p_enforce_limit then
    -- A limit is only "touched" by a live price; yesterday's close is not one.
    -- Missing price = retry next tick (never cancel for it).
    if v_from_cache and v_order_symbol not like 'MF\_%' then
      v_not_live := public._quote_not_live_reason(v_order_symbol);
      if v_not_live is not null then
        raise exception 'no fresh price for % (%)', v_order_symbol, v_not_live;
      end if;
    end if;
    if v_order_side = 'BUY'  and v_market > v_limit_price then
      raise exception 'market has not crossed limit (buy)';
    end if;
    if v_order_side = 'SELL' and v_market < v_limit_price then
      raise exception 'market has not crossed limit (sell)';
    end if;
  end if;

  if v_order_side = 'BUY' then
    v_fill_price := least(v_limit_price, v_market);
  else
    v_fill_price := greatest(v_limit_price, v_market);
  end if;
  v_fill_value := round(v_order_qty * v_fill_price)::bigint;

  perform 1 from public.portfolios where user_id = v_user_id for update;

  if v_order_side = 'BUY' then
    v_refund := v_reserve - v_fill_value;
    if v_refund > 0 then
      update public.portfolios set cash_paise = cash_paise + v_refund, updated_at = now()
        where user_id = v_user_id;
    elsif v_refund < 0 then
      raise exception 'reservation underflow';
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
            jsonb_build_array(jsonb_build_object('bias','limit_order_filled','order_id',p_order_id)),
            'limit_' || p_order_id::text)
    returning id into v_txn_id;

  update public.limit_orders
    set status = 'filled', filled_at = now(),
        filled_price_paise = v_fill_price, filled_txn_id = v_txn_id
    where id = p_order_id;

  return jsonb_build_object('ok', true, 'fill_price', v_fill_price,
                            'txn_id', v_txn_id, 'user_id', v_user_id);
end;
$function$;
