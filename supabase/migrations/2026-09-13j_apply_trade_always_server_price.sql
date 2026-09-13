-- 2026-09-13j — apply_trade always books the server's price. No band.
--
-- 2026-09-12b clamped the client price ONLY when it was >10% off the
-- quote_cache reference; within +/-10% it honored p_price_paise. That handed a
-- crafted request the favorable edge of a 10% window on every trade -- buy at
-- ref-10%, sell at ref+10%, ~+22% per round-trip, compounding. Verified live
-- against the QA account 2026-09-13 (buy@113175 and sell@77907 both honored,
-- then both clamped to ref after this migration).
--
-- The band existed to tolerate a sub-1% cache/quote timing race so an honest
-- fill matched the on-screen price. That is cosmetic and already handled by the
-- price_adjusted flag. There was never a reason to BOOK the trade at the
-- client's number. Fix: v_price is always v_ref_price; p_price_paise is
-- advisory only; v_adjusted reports when they differed so the UI reconciles.

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
begin
  if v_user_id is null then raise exception 'not logged in'; end if;
  if p_side not in ('BUY','SELL') then raise exception 'invalid side: %', p_side; end if;
  if p_qty <= 0 then raise exception 'qty must be positive'; end if;

  if p_idempotency_key is not null then
    select id into v_existing_id
      from public.transactions
      where user_id = v_user_id and idempotency_key = p_idempotency_key
      limit 1;
    if v_existing_id is not null then
      return jsonb_build_object('ok', true, 'txn_id', v_existing_id, 'idempotent', true);
    end if;
  end if;

  select price_paise into v_ref_price
    from public.quote_cache where symbol = p_symbol;
  if v_ref_price is null or v_ref_price <= 0 then
    raise exception 'no price available for %', p_symbol;
  end if;

  -- ALWAYS the server price. p_price_paise never sets the booked price; it is
  -- only the number the UI displayed. v_adjusted tells the client when the two
  -- differed so it can reconcile what it showed. No tolerance band -- honoring
  -- the client price within any band is exactly the exploitable edge.
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
