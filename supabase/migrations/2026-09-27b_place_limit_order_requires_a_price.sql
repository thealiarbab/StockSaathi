-- =============================================================================
-- 2026-09-27b  place_limit_order refuses a symbol the server cannot price
--
-- WHY
--
-- When the browser has no real price for a stock it falls back to
-- synthQuote() in js/data/marketData.js — an invented random-walk price — and
-- the trade form accepted it. place_limit_order never checked that a real
-- price existed, so the order was placed and the cash reserved. But
-- _fill_limit_order_core prices ONLY from quote_cache / mf_master and raises
-- 'no price available' otherwise, so such an order can never fill: the cash
-- sits reserved until the user thinks to cancel.
--
-- Found 2026-09-27: a user ordered ADISOFT at Rs 1,186.95 and APSISAERO at
-- Rs 2,623.56 — both invented numbers; Yahoo has no listing for either new
-- NSE SME stock — with ~Rs 6.4k reserved against orders that cannot execute.
--
-- The guard uses exactly the fill core's rule, so "placeable" and "fillable"
-- cannot drift apart.
-- =============================================================================

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
begin
  if v_user_id is null then raise exception 'not logged in'; end if;
  if p_side not in ('BUY','SELL') then raise exception 'invalid side'; end if;
  if p_qty <= 0 or p_limit_price_paise <= 0 then raise exception 'qty and price must be positive'; end if;

  -- Same pricing rule as _fill_limit_order_core: if the matcher could never
  -- price this symbol, the order could never fill. Refuse it up front.
  if not exists (select 1 from public.quote_cache where symbol = p_symbol and price_paise > 0)
     and not exists (select 1 from public.mf_master where symbol = p_symbol and nav > 0) then
    raise exception 'no live price for % yet, so it cannot be traded right now', p_symbol;
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
      raise exception 'insufficient holding: you hold % and already have % queued to sell',
        v_holding_qty, v_committed;
    end if;
  end if;

  insert into public.limit_orders (user_id, symbol, side, qty, limit_price_paise, reserved_cash)
    values (v_user_id, p_symbol, p_side, p_qty, p_limit_price_paise,
            case when p_side = 'BUY' then v_reserve else 0 end)
    returning id into v_order_id;

  return jsonb_build_object('ok', true, 'order_id', v_order_id);
end;
$function$;
