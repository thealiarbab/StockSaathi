-- =============================================================================
-- 2026-09-12b — Stop trusting client-supplied prices in apply_trade and
--               fill_limit_order.
--
-- Both functions accepted the execution price as a parameter and never checked
-- it against anything. A logged-in user could POST straight to
-- /rest/v1/rpc/apply_trade with p_price_paise = 1, buy 100000 RELIANCE for
-- ₹1000, and sell it back at the real price. fill_limit_order was the same
-- shape: its "has the market crossed the limit" test validated p_market_paise,
-- a number the caller chose, so the order authorised its own fill.
--
-- Design notes — two deliberate departures from the first draft of this fix:
--
--  1. NO staleness rejection. The draft rejected quotes older than 15 minutes.
--     That would have halted all trading overnight and at weekends: the quote
--     TTL is 5 minutes while the market is open, and nothing refreshes the
--     cache after hours. A stale-but-real price still bounds a forgery to the
--     band below, which is the actual goal. Freshness is a data-quality
--     problem (audit brief #3/#4), not an authorisation one.
--
--  2. CLAMP, don't reject, when the client price is out of band. A rejection
--     turns every harmless race (cache 5 min behind a moving micro-cap) into a
--     user-visible failure. Clamping to the server's price makes forgery
--     worthless while letting honest trades through. The response now carries
--     the price actually used plus a price_adjusted flag so the UI can
--     reconcile what it displayed.
--
-- KNOWN CONSEQUENCE, accepted knowingly: a symbol with no quote_cache row
-- cannot be traded at all, in either direction. 14 symbols users already hold
-- are in that state (3BFILMS, 7NR, A1L, ASUTENT, BHAGGAS, BMW, CUPIDALBV plus
-- 7 MF_* codes), because the universe ships BSE and SME rows while the quote
-- handlers append ".NS" unconditionally. Allowing a client price when the
-- cache has no row would reopen the hole completely — an attacker simply picks
-- an unquoted symbol. Those positions stay frozen until audit brief #4 lands.
-- That is the correct trade-off: a position with no price is not a position
-- you can honestly value.
-- =============================================================================

create or replace function public.apply_trade(
  p_symbol          text,
  p_side            text,
  p_qty             numeric,
  p_price_paise     bigint,
  p_idempotency_key text,
  p_bias_flags      jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user_id      uuid := auth.uid();
  v_ref_price    bigint;
  v_price        bigint;
  v_adjusted     boolean := false;
  v_value        bigint;
  v_existing_id  uuid;
  v_holding_id   uuid;
  v_holding_qty  numeric(18,6);
  v_holding_avg  bigint;
  v_new_qty      numeric(18,6);
  v_new_avg      bigint;
  v_txn_id       uuid;
  -- Tolerance between the price the client displayed and the server's last
  -- cached price. Wide enough to absorb a stale cache on a volatile symbol,
  -- far too narrow for a forgery to be worth attempting.
  v_band         numeric := 0.10;
begin
  if v_user_id is null then raise exception 'not logged in'; end if;
  if p_side not in ('BUY','SELL') then raise exception 'invalid side: %', p_side; end if;
  if p_qty <= 0 then raise exception 'qty must be positive'; end if;

  -- Idempotency shortcut
  if p_idempotency_key is not null then
    select id into v_existing_id
      from public.transactions
      where user_id = v_user_id and idempotency_key = p_idempotency_key
      limit 1;
    if v_existing_id is not null then
      return jsonb_build_object('ok', true, 'txn_id', v_existing_id, 'idempotent', true);
    end if;
  end if;

  -- ---- Server-authoritative price -----------------------------------------
  select price_paise into v_ref_price
    from public.quote_cache where symbol = p_symbol;
  if v_ref_price is null or v_ref_price <= 0 then
    raise exception 'no price available for %', p_symbol;
  end if;

  if p_price_paise is null or p_price_paise <= 0
     or abs(p_price_paise - v_ref_price)::numeric / v_ref_price > v_band then
    v_price    := v_ref_price;   -- outside the band: the server wins
    v_adjusted := true;
  else
    v_price    := p_price_paise; -- inside the band: honour the displayed fill
  end if;

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
$fn$;

grant execute on function public.apply_trade(text, text, numeric, bigint, text, jsonb) to authenticated;

-- =============================================================================
-- fill_limit_order — same treatment. p_market_paise is now only a hint; the
-- crossing test and the fill price both come from quote_cache.
-- =============================================================================
create or replace function public.fill_limit_order(
  p_order_id      uuid,
  p_market_paise  bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user_id       uuid := auth.uid();
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
begin
  if v_user_id is null then raise exception 'not logged in'; end if;

  select symbol, side, qty, limit_price_paise, reserved_cash, status
    into v_order_symbol, v_order_side, v_order_qty, v_limit_price, v_reserve, v_status
    from public.limit_orders
    where id = p_order_id and user_id = v_user_id
    for update;
  if not found then raise exception 'order not found'; end if;
  if v_status <> 'pending' then raise exception 'already %', v_status; end if;

  -- The market price comes from the server, never from the caller. Without
  -- this the order authorised its own fill.
  select price_paise into v_market
    from public.quote_cache where symbol = v_order_symbol;
  if v_market is null or v_market <= 0 then
    raise exception 'no price available for %', v_order_symbol;
  end if;

  if v_order_side = 'BUY' and v_market > v_limit_price then
    raise exception 'market has not crossed limit (buy)';
  end if;
  if v_order_side = 'SELL' and v_market < v_limit_price then
    raise exception 'market has not crossed limit (sell)';
  end if;

  -- Fill at the better of limit or market (price improvement for the user)
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
      raise exception 'insufficient holding at fill time';
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

  return jsonb_build_object('ok', true, 'fill_price', v_fill_price, 'txn_id', v_txn_id);
end;
$fn$;

grant execute on function public.fill_limit_order(uuid, bigint) to authenticated;
