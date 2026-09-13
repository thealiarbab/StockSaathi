-- =============================================================================
-- 2026-09-13l — portfolio snapshots must survive an absurd holdings row.
--
-- APPLIED TO PRODUCTION 2026-09-13 14:26 UTC as remote migration
-- `20260913142652_portfolio_snapshot_overflow_safe`. This file was written
-- afterwards to close a repo/database gap — the migration went in through the
-- Supabase API and never landed in `supabase/migrations/`.
--
-- The bodies below are dumped from the live database (pg_get_functiondef), so
-- this file is the authoritative definition of both functions. Applying it is
-- sufficient; 2026-09-13k is retained only as the record of why they exist.
--
-- WHY
--
-- Found by actually running admin_portfolio_snapshot_mtm against production
-- with a real 115-symbol price map. It raised:
--
--     ERROR 22003: bigint out of range
--
-- Cause: user 73c89104 holds qty = 999,999,999,999 of ~12 of the most expensive
-- symbols on the exchange (MRF, BOSCHLTD, PAGEIND, 3MINDIA...) at
-- avg_cost_paise = 0. Cost basis therefore reads 0 and the old cost-basis path
-- never noticed. The moment holdings are valued at a REAL price,
-- 999999999999 * 12829000 = 1.28e19 paise, which is past bigint's 9.22e18.
--
-- The severity is not the overflow itself, it is the blast radius: holdings are
-- summed per user inside one loop, and an uncaught error aborts the whole
-- function. ONE nonsense row stopped the daily snapshot for ALL 44 trading
-- users. A snapshot job must be robust to garbage in one account.
--
-- Fix: do the arithmetic in numeric (unbounded), clamp once at the end, and
-- catch per user so a single bad account cannot cost everyone else their point.
-- Report how many users were clamped or failed so this stays VISIBLE instead of
-- silently writing a capped number that looks real.
--
-- The absurd qty itself is a separate data-integrity problem and is
-- deliberately NOT rewritten here — a snapshot job has no business editing
-- someone's holdings. See 2026-09-13e_revoke_direct_writes_on_money_tables.sql
-- for the write-path hole that allowed it.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_portfolio_snapshot_mtm(p_prices jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      cv := u.cash_paise;
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
      -- One broken account must never cost the other 43 their snapshot.
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
    'valuation', 'mark_to_market_with_cost_basis_fallback',
    'ts', now()
  );
end;
$function$;

revoke all on function public.admin_portfolio_snapshot_mtm(jsonb) from public, anon, authenticated;
grant execute on function public.admin_portfolio_snapshot_mtm(jsonb) to service_role;


-- Same treatment for the cost-basis path. It does not overflow on today's data
-- (the absurd rows have avg_cost_paise = 0), but it is the same shape of loop
-- with the same single-point-of-failure, and a future backfill run must not be
-- one bad row away from doing nothing.
--
-- p_today_only = false additionally seeds the signup anchor described in
-- 2026-09-13k: starting cash at auth.users.created_at, per trading user.
CREATE OR REPLACE FUNCTION public.admin_portfolio_backfill(p_today_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  c_cap    constant numeric := 9000000000000000000;
  n_users  int := 0;
  n_anchor int := 0;
  n_today  int := 0;
  n_skip   int := 0;
  n_failed int := 0;
  u record;
  hv_num numeric;
  hv bigint;
  cv bigint;
  tv bigint;
begin
  for u in
    select p.user_id,
           p.cash_paise,
           p.starting_cash_paise,
           au.created_at as signed_up_at
      from public.portfolios p
      join auth.users au on au.id = p.user_id
     where exists (select 1 from public.transactions t where t.user_id = p.user_id)
  loop
    n_users := n_users + 1;
    begin
      select coalesce(sum(h.qty * h.avg_cost_paise::numeric), 0)
        into hv_num
        from public.holdings h
       where h.user_id = u.user_id;
      hv_num := least(greatest(hv_num, 0), c_cap);
      hv := hv_num::bigint;
      cv := u.cash_paise;
      tv := least(hv::numeric + cv::numeric, c_cap)::bigint;

      if not p_today_only then
        delete from public.portfolio_history
         where user_id = u.user_id and source = 'backfill';
        insert into public.portfolio_history
          (user_id, ts, total_value_paise, cash_paise, holdings_value_paise, source)
        values
          (u.user_id, u.signed_up_at, u.starting_cash_paise, u.starting_cash_paise, 0, 'backfill');
        n_anchor := n_anchor + 1;
      end if;

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
        n_today := n_today + 1;
      end if;
    exception when others then
      n_failed := n_failed + 1;
      raise warning 'backfill failed for user %: % (%)', u.user_id, SQLERRM, SQLSTATE;
    end;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'mode', case when p_today_only then 'today_only' else 'full' end,
    'traders', n_users,
    'anchors_written', n_anchor,
    'snapshots_written', n_today,
    'snapshots_skipped_already_today', n_skip,
    'users_failed', n_failed,
    'valuation', 'cost_basis',
    'ts', now()
  );
end;
$function$;

revoke all on function public.admin_portfolio_backfill(boolean) from public, anon, authenticated;
grant execute on function public.admin_portfolio_backfill(boolean) to service_role;
