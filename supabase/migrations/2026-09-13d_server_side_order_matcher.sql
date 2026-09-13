-- =============================================================================
-- 2026-09-13d — SERVER-SIDE ORDER MATCHER
--
-- THE BUG THIS FIXES
-- ------------------
-- Order execution was client-driven. features/limitOrders.js started a 12 s
-- polling loop in the USER'S OWN BROWSER TAB, and matchOnce() early-returned
-- unless marketStatus().open. There was no server-side counterpart anywhere:
-- no pg_cron, no pg_net, no Edge Function, no Vercel cron.
--
-- So an order could only ever fill while the user personally had StockSaathi
-- open in a tab, on a weekday, between 09:15 and 15:30 IST. That window is
-- the school day for a product aimed at 13-18 year olds. One affected user
-- wrote, in the same thread where he was asking why his order never filled:
-- "Yaar me 8 se 2 baje busy rahta hu to trading kaise karu".
--
-- Result: 75 pending orders, 42 of which already met their fill condition,
-- the oldest untouched for 87 days, with the users' cash reserved against
-- them the whole time.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1. Extracts the fill logic out of fill_limit_order into a shared internal
--    core that takes the owner explicitly instead of reading auth.uid().
-- 2. Re-points the existing authed RPC at that core (behaviour unchanged).
-- 3. Adds admin_fill_limit_order, callable by the service role only, so a
--    server cron can fill any user's order with no browser involved.
-- 4. Adds admin_pending_orders so the matcher can read every user's pending
--    orders in one call without disabling RLS.
--
-- Idempotent. Safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Shared fill core. Identical arithmetic to the pre-existing
--    fill_limit_order, with v_user_id sourced from the ORDER ROW rather than
--    auth.uid(). p_enforce_limit lets the backfill fill an order at its own
--    frozen limit price without re-asserting a live market condition.
-- -----------------------------------------------------------------------------
create or replace function public._fill_limit_order_core(
  p_order_id      uuid,
  p_market_paise  bigint,
  p_enforce_limit boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id       uuid;
  v_order_symbol  text;
  v_order_side    text;
  v_order_qty     numeric(18,6);
  v_limit_price   bigint;
  v_reserve       bigint;
  v_status        text;
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
  select user_id, symbol, side, qty, limit_price_paise, reserved_cash, status
    into v_user_id, v_order_symbol, v_order_side, v_order_qty,
         v_limit_price, v_reserve, v_status
    from public.limit_orders
    where id = p_order_id
    for update;
  if not found then raise exception 'order not found'; end if;
  if v_status <> 'pending' then raise exception 'already %', v_status; end if;

  if p_enforce_limit then
    if v_order_side = 'BUY'  and p_market_paise > v_limit_price then
      raise exception 'market has not crossed limit (buy)';
    end if;
    if v_order_side = 'SELL' and p_market_paise < v_limit_price then
      raise exception 'market has not crossed limit (sell)';
    end if;
  end if;

  -- Fill at the better of limit or market (price improvement for the user).
  if v_order_side = 'BUY' then
    v_fill_price := least(v_limit_price, p_market_paise);
  else
    v_fill_price := greatest(v_limit_price, p_market_paise);
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

  return jsonb_build_object('ok', true, 'fill_price', v_fill_price,
                            'txn_id', v_txn_id, 'user_id', v_user_id);
end;
$$;

-- The core must never be reachable from a browser: it takes the owner from
-- the row, so a direct call would let any authenticated user fill anyone's
-- order. Only the two wrappers below may invoke it.
revoke all on function public._fill_limit_order_core(uuid, bigint, boolean) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. The authed RPC keeps its exact old contract: a user may only fill their
--    OWN order, and the live-market condition is always enforced.
-- -----------------------------------------------------------------------------
create or replace function public.fill_limit_order(
  p_order_id      uuid,
  p_market_paise  bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_owner   uuid;
begin
  if v_user_id is null then raise exception 'not logged in'; end if;
  select user_id into v_owner from public.limit_orders where id = p_order_id;
  if v_owner is null then raise exception 'order not found'; end if;
  if v_owner <> v_user_id then raise exception 'order not found'; end if;
  return public._fill_limit_order_core(p_order_id, p_market_paise, true);
end;
$$;

revoke all on function public.fill_limit_order(uuid, bigint) from public, anon;
grant execute on function public.fill_limit_order(uuid, bigint) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Service-role fill. This is what makes execution independent of whether
--    the user has the app open. `p_enforce_limit => false` is used only by
--    the one-off backfill, which fills at the order's own frozen limit price.
-- -----------------------------------------------------------------------------
create or replace function public.admin_fill_limit_order(
  p_order_id      uuid,
  p_market_paise  bigint,
  p_enforce_limit boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public._fill_limit_order_core(p_order_id, p_market_paise, p_enforce_limit);
end;
$$;

revoke all on function public.admin_fill_limit_order(uuid, bigint, boolean) from public, anon, authenticated;
grant execute on function public.admin_fill_limit_order(uuid, bigint, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- 4. Every user's pending orders, for the matcher. Service role only.
-- -----------------------------------------------------------------------------
create or replace function public.admin_pending_orders()
returns table (
  id                uuid,
  user_id           uuid,
  symbol            text,
  side              text,
  qty               numeric,
  limit_price_paise bigint,
  reserved_cash     bigint,
  created_at        timestamptz
)
language sql
security definer
set search_path = public
as $$
  select id, user_id, symbol, side, qty, limit_price_paise, reserved_cash, created_at
    from public.limit_orders
   where status = 'pending'
   order by created_at asc;
$$;

revoke all on function public.admin_pending_orders() from public, anon, authenticated;
grant execute on function public.admin_pending_orders() to service_role;

-- Matcher reads pending rows on every tick; keep that cheap.
create index if not exists limit_orders_pending_idx
  on public.limit_orders (status, created_at)
  where status = 'pending';
