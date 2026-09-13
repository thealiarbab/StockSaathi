-- =============================================================================
-- 2026-09-13f — Restore server-side pricing in the limit-order fill path.
--
-- THIS IS A REGRESSION FIX, NOT A NEW FIX.
--
-- 2026-09-12b hardened `fill_limit_order` to take both the crossing test and
-- the fill price from `public.quote_cache`, so `p_market_paise` became a hint
-- the server ignored.
--
-- 2026-09-13d then refactored the fill path into `_fill_limit_order_core` so
-- the server-side matcher and the client could share one body — and in doing
-- so wrote the body from the PRE-12b version. The quote_cache lookup was
-- dropped and `p_market_paise` went back to driving both decisions. Verified
-- against production 2026-09-13: `apply_trade` contains 'quote_cache',
-- `_fill_limit_order_core` does not.
--
-- Net effect: yesterday's security fix survived for about 24 hours, and the
-- hole reopened through a refactor that was reviewed as a feature change.
--
-- WHAT THE REGRESSION ALLOWS
-- --------------------------
-- `p_market_paise` is caller-supplied and `fill_limit_order(uuid, bigint)` is
-- granted to `authenticated`. It feeds BOTH:
--   1. the crossing gate   (`p_market_paise > / < v_limit_price`)
--   2. the fill price      (`least/greatest(v_limit_price, p_market_paise)`)
-- so the caller authorises their own fill and then names its price. A SELL
-- limit filled with a huge p_market_paise credits arbitrary cash:
--   fill_limit_order('<own pending sell>', 999999999999999)
-- This is an independent entry point from `apply_trade` — 12b's surviving fix
-- there does not cover it.
--
-- THE FIX
-- -------
-- Price the fill from the server's own sources. `p_market_paise` stays in the
-- signature (the deployed frontend and the matcher both pass it) and is
-- ignored. `fill_limit_order` and `admin_fill_limit_order` are unchanged thin
-- wrappers, so both inherit this.
--
-- MUTUAL FUNDS — the trap this fix has to avoid.
-- `quote_cache` has no MF coverage; the matcher prices MF_* from `mf_master`
-- (handlers/match-orders.py:281-295), falling back to a static JSON. A fix
-- that simply required a quote_cache row would make every MF limit order
-- permanently unfillable — which is precisely the failure AGENTS.md records
-- from the old client ("every MF order was guaranteed to be destroyed").
-- So: quote_cache first, then mf_master.nav, then refuse.
--
-- Refusing (rather than cancelling) is deliberate and matches the standing
-- rule: never destroy an order the matcher cannot price. The matcher catches
-- per-order exceptions and continues (handlers/match-orders.py:288-295), so an
-- unpriceable order simply stays pending and is retried next tick.
--
-- No staleness check, consistent with 12b's reasoning: the quote TTL is 5 min
-- during market hours and nothing refreshes it after close, so a staleness
-- rejection would halt all evening and weekend trading. A stale-but-real price
-- still bounds a forgery to the real market; freshness is a data-quality
-- problem, not an authorisation one.
-- =============================================================================

create or replace function public._fill_limit_order_core(
  p_order_id      uuid,
  p_market_paise  bigint,   -- IGNORED. Retained for signature compatibility.
  -- `default true` must be preserved: CREATE OR REPLACE cannot remove an
  -- existing parameter default ("42P13: cannot remove parameter defaults"),
  -- and dropping the function to get around that would also drop the grant
  -- revokes and the wrappers' dependency on it.
  p_enforce_limit boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
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
begin
  select user_id, symbol, side, qty, limit_price_paise, reserved_cash, status
    into v_user_id, v_order_symbol, v_order_side, v_order_qty,
         v_limit_price, v_reserve, v_status
    from public.limit_orders
    where id = p_order_id
    for update;
  if not found then raise exception 'order not found'; end if;
  if v_status <> 'pending' then raise exception 'already %', v_status; end if;

  -- ---- Server-side price. p_market_paise is not consulted. ------------------
  select price_paise into v_market
    from public.quote_cache where symbol = v_order_symbol;

  if v_market is null then
    -- Mutual funds live in mf_master, never in quote_cache.
    select round(nav * 100)::bigint into v_market
      from public.mf_master
      where symbol = v_order_symbol and nav is not null and nav > 0;
  end if;

  if v_market is null or v_market <= 0 then
    -- Stays pending. The matcher retries next tick; never auto-cancel.
    raise exception 'no price available for %, cannot fill', v_order_symbol;
  end if;

  if p_enforce_limit then
    if v_order_side = 'BUY'  and v_market > v_limit_price then
      raise exception 'market has not crossed limit (buy)';
    end if;
    if v_order_side = 'SELL' and v_market < v_limit_price then
      raise exception 'market has not crossed limit (sell)';
    end if;
  end if;

  -- Price improvement still favours the user, but is now bounded by a real
  -- market price instead of a number the caller chose.
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

  return jsonb_build_object('ok', true, 'fill_price', v_fill_price,
                            'txn_id', v_txn_id, 'user_id', v_user_id);
end;
$fn$;

-- The core is internal plumbing: it takes the owner from the order row rather
-- than auth.uid(), so it must never be callable directly over PostgREST.
revoke execute on function public._fill_limit_order_core(uuid, bigint, boolean)
  from public, anon, authenticated;

-- ---- Verification (run after applying) --------------------------------------
--   select proname, prosrc like '%quote_cache%' as priced_server_side
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname='public'
--      and proname in ('apply_trade','_fill_limit_order_core');
--   -- both must be true. If _fill_limit_order_core is false, this regressed again.
--
-- Behavioural check with a real logged-in JWT:
--   place a SELL limit, then
--   POST /rest/v1/rpc/fill_limit_order {"p_order_id":"<id>","p_market_paise":999999999999999}
--   -> must fill at the real market price, or raise 'market has not crossed
--      limit (sell)'. It must NOT credit cash based on the passed number.
