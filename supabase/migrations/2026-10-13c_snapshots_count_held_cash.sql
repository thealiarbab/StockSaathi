-- O10: portfolio_history left out cash held for pending BUY orders, so a
-- user with a big order queued showed a fake 20-50% drop on their chart
-- (traderrizwan Rs 50,084 vs a true ~Rs 1,00,254 on 13 Oct). That cash is
-- still theirs. Both writers now count it in cash_paise and the total:
-- the daily mark-to-market snapshot and the per-trade trigger.

create or replace function public._reserved_buy_cash(p_user uuid)
 returns bigint
 language sql
 stable
 security definer
 set search_path to 'public'
as $$
  select coalesce(sum(reserved_cash), 0)::bigint
    from public.limit_orders
   where user_id = p_user and status = 'pending' and side = 'BUY';
$$;
revoke all on function public._reserved_buy_cash(uuid) from public, anon, authenticated;

create or replace function public.on_transaction_insert_snapshot()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  hv bigint;
  cv bigint;
begin
  select coalesce(sum(qty * avg_cost_paise), 0)::bigint into hv
    from public.holdings where user_id = new.user_id;
  select cash_paise into cv from public.portfolios where user_id = new.user_id;
  cv := coalesce(cv, 0) + public._reserved_buy_cash(new.user_id);
  insert into public.portfolio_history
    (user_id, ts, total_value_paise, cash_paise, holdings_value_paise, source)
    values (new.user_id, new.created_at, hv + cv, cv, hv, 'trade');
  return new;
end;
$function$;

create or replace function public.admin_portfolio_snapshot_mtm(p_prices jsonb default '{}'::jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  -- Comfortably inside bigint (9.223e18) with room for cash on top.
  c_cap    constant numeric := 9000000000000000000;
  n_users   int := 0;
  n_written int := 0;
  n_skip    int := 0;
  n_clamped int := 0;
  n_failed  int := 0;
  u record;
  hv_num numeric;
  hv bigint;
  cv bigint;
  tv bigint;
begin
  for u in
    select p.user_id, p.cash_paise
      from public.portfolios p
     where exists (select 1 from public.transactions t where t.user_id = p.user_id)
  loop
    n_users := n_users + 1;
    begin
      -- numeric throughout: qty is numeric(_, 6) and a hostile qty times a
      -- real price exceeds bigint long before the cast would tell us.
      select coalesce(sum(
               h.qty * case
                         when coalesce((p_prices ->> h.symbol)::numeric, 0) > 0
                           then (p_prices ->> h.symbol)::numeric
                         else h.avg_cost_paise::numeric
                       end
             ), 0)
        into hv_num
        from public.holdings h
       where h.user_id = u.user_id;

      if hv_num > c_cap then
        hv_num := c_cap;
        n_clamped := n_clamped + 1;
      elsif hv_num < 0 then
        hv_num := 0;
      end if;

      hv := hv_num::bigint;
      -- Cash held for pending BUY orders is still the user's money.
      cv := u.cash_paise + public._reserved_buy_cash(u.user_id);
      tv := least(hv::numeric + cv::numeric, c_cap)::bigint;

      if exists (
        select 1 from public.portfolio_history
         where user_id = u.user_id
           and source = 'daily_snapshot'
           and ts >= date_trunc('day', now())
      ) then
        n_skip := n_skip + 1;
      else
        insert into public.portfolio_history
          (user_id, ts, total_value_paise, cash_paise, holdings_value_paise, source)
        values
          (u.user_id, now(), tv, cv, hv, 'daily_snapshot');
        n_written := n_written + 1;
      end if;
    exception when others then
      -- One broken account must never cost the other users their snapshot.
      n_failed := n_failed + 1;
      raise warning 'snapshot failed for user %: % (%)', u.user_id, SQLERRM, SQLSTATE;
    end;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'traders', n_users,
    'snapshots_written', n_written,
    'skipped_already_today', n_skip,
    'users_value_clamped', n_clamped,
    'users_failed', n_failed,
    'price_map_size', (select count(*) from jsonb_object_keys(p_prices)),
    'valuation', 'mark_to_market_with_cost_basis_fallback_plus_held_cash',
    'ts', now()
  );
end;
$function$;
