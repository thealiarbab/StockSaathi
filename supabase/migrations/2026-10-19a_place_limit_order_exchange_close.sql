-- =============================================================================
-- place_limit_order: the exchange's own close counts as "a price".
--
-- WHY: the RPC refused any symbol without a quote_cache row (2026-09-27b), so
-- the browser had to call /api/live-quote first to create one. That put a
-- round trip to our Vercel API (and from there to Yahoo) in front of every
-- limit order. On 19 Oct a user's limit BUY spent 23.7 s on that call before
-- the RPC was even sent (Supabase: nothing between the tap and the insert;
-- Vercel: live-quote ran in under 0.5 s that minute), and the next order hit
-- the 25 s timeout with "Supabase may be unreachable". Supabase was fine.
--
-- The reference price only bounds the limit (within 20%) and sizes an
-- at-the-open hold; it was already allowed to come from nse_eod_prices when
-- quote_cache had no row. 768 listed stocks have an NSE close but no
-- quote_cache row, and BSE-only stocks have bse_eod_prices. Accept either, so
-- placing an order is one database call and nothing else.
--
-- Unchanged: an order still never FILLS on an end-of-day price. The matcher
-- needs a live quote from today (_quote_not_live_reason).
-- =============================================================================

create or replace function public.place_limit_order(
  p_symbol text, p_side text, p_qty numeric, p_limit_price_paise bigint,
  p_order_type text default 'LIMIT'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user_id      uuid := auth.uid();
  v_type         text := upper(coalesce(p_order_type, 'LIMIT'));
  v_reserve      bigint;
  v_holding_qty  numeric(18,6);
  v_committed    numeric(18,6);
  v_order_id     uuid;
  v_ref          bigint;
  v_limit        bigint := p_limit_price_paise;
begin
  if v_user_id is null then raise exception 'not logged in'; end if;
  if p_side not in ('BUY','SELL') then raise exception 'invalid side'; end if;
  if p_qty <= 0 or p_limit_price_paise <= 0 then raise exception 'qty and price must be positive'; end if;
  if p_symbol like 'MF\_%' then v_type := 'MF';
  elsif v_type not in ('LIMIT', 'AMO_MARKET') then raise exception 'invalid order type';
  end if;

  if v_type = 'MF' then
    if not exists (select 1 from public.mf_master where symbol = p_symbol and nav > 0) then
      raise exception 'no live price for % yet, so it cannot be traded right now', p_symbol;
    end if;
  else
    select price_paise into v_ref from public.quote_cache where symbol = p_symbol and price_paise > 0;
    if v_ref is null then
      select close_paise into v_ref from public.nse_eod_prices
       where symbol = p_symbol and close_paise > 0 order by trade_date desc limit 1;
    end if;
    if v_ref is null then
      select close_paise into v_ref from public.bse_eod_prices
       where symbol = p_symbol and close_paise > 0 order by trade_date desc limit 1;
    end if;
    if v_ref is null then
      raise exception 'no live price for % yet, so it cannot be traded right now', p_symbol;
    end if;
  end if;

  if v_type = 'LIMIT'
     and (v_limit < round(v_ref * 0.8) or v_limit > round(v_ref * 1.2)) then
    raise exception 'Limit must be within 20%% of the last price (₹% – ₹%).',
      to_char(round(v_ref * 0.8) / 100.0, 'FM99999990.00'),
      to_char(round(v_ref * 1.2) / 100.0, 'FM99999990.00');
  end if;

  if v_type = 'AMO_MARKET' then
    v_limit := v_ref;
    v_reserve := round(p_qty * v_limit * 1.2)::bigint;
  else
    v_reserve := round(p_qty * v_limit)::bigint;
  end if;

  if p_side = 'BUY' then
    update public.portfolios set cash_paise = cash_paise - v_reserve, updated_at = now()
      where user_id = v_user_id and cash_paise >= v_reserve;
    if not found then
      if v_type = 'AMO_MARKET' then
        raise exception 'Not enough cash: an order at the open holds 20%% extra (₹%) in case the price opens higher. Lower the quantity or use a limit order.',
          to_char(v_reserve / 100.0, 'FM99999990.00');
      end if;
      raise exception 'insufficient cash';
    end if;
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

  insert into public.limit_orders (user_id, symbol, side, qty, limit_price_paise, reserved_cash, order_type, nav_from_date)
    values (v_user_id, p_symbol, p_side, p_qty, v_limit,
            case when p_side = 'BUY' then v_reserve else 0 end,
            v_type,
            case when v_type = 'MF' then public._mf_nav_from_date(p_symbol, now()) end)
    returning id into v_order_id;

  return jsonb_build_object('ok', true, 'order_id', v_order_id, 'order_type', v_type,
    'reserved_paise', case when p_side = 'BUY' then v_reserve else 0 end,
    'nav_from_date', case when v_type = 'MF' then public._mf_nav_from_date(p_symbol, now()) end);
end;
$function$;
