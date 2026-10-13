-- Order lifecycle: O4 (after-hours market orders), O5 (fund orders), O8 (expiry).
--
-- O4  An after-hours order was really a LIMIT at the last close, while the
--     banner promised "the opening price": a BUY could only fill if the
--     stock fell back to yesterday's close. AMO_MARKET orders now fill at
--     the first live price after the open. A BUY reserves 20% headroom (the
--     widest NSE band) and gets the difference back at the fill.
-- O5  Fund orders were matched as price limits on the NAV, so a BUY only
--     filled if the next NAV was LOWER (vasiwsp: stuck since 5 Oct). MF
--     orders now allot at the NAV for the day they count for: the order's
--     own day if placed before the cut-off (15:00 IST; 13:30 for liquid,
--     overnight and money-market funds), else the next day with a NAV.
--     Buys are by rupee amount: units = amount / NAV.
-- O8  Orders never expired (oldest 17 Sep, cash held throughout). Orders
--     are now valid 30 days. A daily job warns 3 days ahead, then cancels
--     with a refund; both steps leave the user a notice.

alter table public.limit_orders
  add column if not exists order_type text not null default 'LIMIT',
  add column if not exists nav_from_date date,
  add column if not exists expires_at timestamptz,
  add column if not exists expiry_warned_at timestamptz;
alter table public.limit_orders drop constraint if exists limit_orders_order_type_check;
alter table public.limit_orders add constraint limit_orders_order_type_check
  check (order_type in ('LIMIT', 'AMO_MARKET', 'MF'));
update public.limit_orders set expires_at = created_at + interval '30 days' where expires_at is null;
alter table public.limit_orders alter column expires_at set default (now() + interval '30 days');

-- First NAV date a fund order may be allotted at.
create or replace function public._mf_nav_from_date(p_symbol text, p_ts timestamptz)
 returns date
 language sql
 stable
 security definer
 set search_path to 'public'
as $$
  select case
    when (p_ts at time zone 'Asia/Kolkata')::time >=
         case when exists (select 1 from public.mf_master m
                            where m.symbol = p_symbol
                              and (m.category ilike '%liquid%' or m.category ilike '%overnight%'
                                   or m.category ilike '%money market%'))
              then time '13:30' else time '15:00' end
      then (p_ts at time zone 'Asia/Kolkata')::date + 1
    else (p_ts at time zone 'Asia/Kolkata')::date
  end;
$$;

drop function if exists public.place_limit_order(text, text, numeric, bigint);
create or replace function public.place_limit_order(p_symbol text, p_side text, p_qty numeric, p_limit_price_paise bigint, p_order_type text default 'LIMIT')
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
  -- A fund order is always an MF order, whatever an older client sends.
  if p_symbol like 'MF\_%' then v_type := 'MF';
  elsif v_type not in ('LIMIT', 'AMO_MARKET') then raise exception 'invalid order type';
  end if;

  if not exists (select 1 from public.quote_cache where symbol = p_symbol and price_paise > 0)
     and not exists (select 1 from public.mf_master where symbol = p_symbol and nav > 0) then
    raise exception 'no live price for % yet, so it cannot be traded right now', p_symbol;
  end if;

  if v_type <> 'MF' then
    select price_paise into v_ref from public.quote_cache where symbol = p_symbol and price_paise > 0;
    if v_ref is null then
      select close_paise into v_ref from public.nse_eod_prices
       where symbol = p_symbol and close_paise > 0 order by trade_date desc limit 1;
    end if;
  end if;

  if v_type = 'LIMIT' and v_ref is not null
     and (v_limit < round(v_ref * 0.8) or v_limit > round(v_ref * 1.2)) then
    raise exception 'Limit must be within 20%% of the last price (₹% – ₹%).',
      to_char(round(v_ref * 0.8) / 100.0, 'FM99999990.00'),
      to_char(round(v_ref * 1.2) / 100.0, 'FM99999990.00');
  end if;

  if v_type = 'AMO_MARKET' then
    -- The stored price is only the reference shown to the user.
    v_limit := coalesce(v_ref, p_limit_price_paise);
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
grant execute on function public.place_limit_order(text, text, numeric, bigint, text) to authenticated;
revoke execute on function public.place_limit_order(text, text, numeric, bigint, text) from anon;

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

drop function if exists public.admin_pending_orders();
create or replace function public.admin_pending_orders()
 returns table(id uuid, user_id uuid, symbol text, side text, qty numeric, limit_price_paise bigint,
               reserved_cash bigint, created_at timestamptz, order_type text, nav_from_date date)
 language sql
 security definer
 set search_path to 'public'
as $function$
  select id, user_id, symbol, side, qty, limit_price_paise, reserved_cash, created_at, order_type, nav_from_date
    from public.limit_orders
   where status = 'pending'
   order by created_at asc;
$function$;
revoke all on function public.admin_pending_orders() from public, anon, authenticated;
grant execute on function public.admin_pending_orders() to service_role;

-- Daily: warn 3 days ahead, then expire with a refund. One notice per user
-- per run for each of the two.
create or replace function public.admin_expire_orders()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  n_warned int := 0;
  n_expired int := 0;
begin
  drop table if exists _warn;
  drop table if exists _exp;
  create temp table _warn on commit drop as
    with w as (
      update public.limit_orders
         set expiry_warned_at = now()
       where status = 'pending' and expiry_warned_at is null
         and expires_at > now() and expires_at <= now() + interval '3 days'
      returning user_id, symbol, side, qty, limit_price_paise, order_type, expires_at)
    select * from w;
  get diagnostics n_warned = row_count;

  insert into public.user_notices (user_id, kind, title, body, payload)
  select user_id, 'order_expiring',
    case when count(*) = 1 then 'An order expires soon' else format('%s orders expire soon', count(*)) end,
    format('Orders stay open for 30 days, like a good-till-cancelled order at a real broker. %s will close on %s unless %s first. Any cash held for %s comes back automatically.',
      case when count(*) = 1 then 'This one' else 'These' end,
      to_char(min(expires_at) at time zone 'Asia/Kolkata', 'FMDD Mon'),
      case when count(*) = 1 then 'it fills' else 'they fill' end,
      case when count(*) = 1 then 'it' else 'them' end),
    jsonb_build_object('cta', jsonb_build_object('label', 'See my orders', 'href', '/portfolio'),
      'orders', jsonb_agg(jsonb_build_object('side', side, 'symbol', symbol, 'qty', qty,
        'price_inr', round(limit_price_paise / 100.0, 2), 'outcome', 'expiring',
        'note', 'closes ' || to_char(expires_at at time zone 'Asia/Kolkata', 'FMDD Mon')) order by expires_at))
  from _warn group by user_id;

  create temp table _exp on commit drop as
    with e as (
      update public.limit_orders
         set status = 'cancelled', cancelled_at = now(), cancel_reason = 'expired'
       where status = 'pending' and expires_at <= now()
      returning user_id, symbol, side, qty, limit_price_paise, reserved_cash)
    select * from e;
  get diagnostics n_expired = row_count;

  update public.portfolios p set cash_paise = p.cash_paise + r.amt, updated_at = now()
    from (select user_id, sum(reserved_cash) amt from _exp where side = 'BUY' and reserved_cash > 0 group by 1) r
   where p.user_id = r.user_id;

  insert into public.user_notices (user_id, kind, title, body, payload)
  select user_id, 'order_expired',
    case when count(*) = 1 then 'An order expired' else format('%s orders expired', count(*)) end,
    'These orders reached the 30-day limit without filling, so they have closed.' ||
      case when sum(case when side = 'BUY' then reserved_cash else 0 end) > 0
           then ' The cash held for them is back in your account.' else '' end ||
      ' Place them again any time if you still want them.',
    jsonb_build_object(
      'refund_total_inr', round(sum(case when side = 'BUY' then reserved_cash else 0 end) / 100.0, 2),
      'cta', jsonb_build_object('label', 'See my orders', 'href', '/portfolio'),
      'orders', jsonb_agg(jsonb_build_object('side', side, 'symbol', symbol, 'qty', qty,
        'price_inr', round(limit_price_paise / 100.0, 2), 'outcome', 'expired') order by symbol))
  from _exp group by user_id;

  return jsonb_build_object('ok', true, 'warned', n_warned, 'expired', n_expired, 'ts', now());
end;
$function$;
revoke all on function public.admin_expire_orders() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'order-expiry';
select cron.schedule('order-expiry', '30 20 * * *', $$select public.admin_expire_orders()$$);
