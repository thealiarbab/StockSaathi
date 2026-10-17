-- Admin panel egress (17 Oct 2026).
--
-- The org went over the Free plan's 5 GB egress. Two admin-panel paths were
-- a large share of it:
--   * op=admin-overview pulled seven whole tables (3.5 MB of JSON) into the
--     Edge function just to count and sum them per user.
--   * op=admin-tail read five tables every 2 seconds for as long as an admin
--     tab stayed open (153k requests on 16 Oct, half of all API traffic).
-- Both now make one call to a function that does the work in Postgres and
-- returns only the result.

-- 1. Overview: one compact row per user plus table counts.
--    users[i] = [id, username, display_name, email, age, school, class_code,
--                city, risk_profile, avatar_color, onboarded, created_at,
--                updated_at, cash_paise, starting_cash_paise,
--                portfolio_updated_at, holdings_cost_paise, holding_count,
--                trade_count, traded_value_paise, bias_flag_count,
--                last_trade_at, coach_count, watchlist_count, order_count]
create or replace function public.admin_overview()
returns jsonb
language sql
stable
set search_path = public
as $$
  with tx as (
    select user_id,
           count(*) as n,
           sum(value_paise) as traded,
           sum(case when jsonb_typeof(bias_flags) = 'array' then jsonb_array_length(bias_flags) else 0 end) as flags,
           max(created_at) as last_at
      from transactions group by user_id
  ), co as (
    select user_id, count(*) as n from coach_messages group by user_id
  ), ho as (
    select user_id, count(*) as n, sum(qty * avg_cost_paise) as cost from holdings group by user_id
  ), wl as (
    select user_id, count(*) as n from watchlist group by user_id
  ), lo as (
    select user_id, count(*) as n from limit_orders group by user_id
  )
  select jsonb_build_object(
    'users', coalesce((
      select jsonb_agg(jsonb_build_array(
               p.id, p.username, p.display_name, p.email, p.age, p.school, p.class_code,
               p.city, p.risk_profile, p.avatar_color, p.onboarded, p.created_at,
               p.updated_at, pf.cash_paise, pf.starting_cash_paise, pf.updated_at,
               coalesce(round(ho.cost), 0), coalesce(ho.n, 0),
               coalesce(tx.n, 0), coalesce(tx.traded, 0), coalesce(tx.flags, 0), tx.last_at,
               coalesce(co.n, 0), coalesce(wl.n, 0), coalesce(lo.n, 0))
             order by p.created_at desc)
        from profiles p
        left join portfolios pf on pf.user_id = p.id
        left join tx on tx.user_id = p.id
        left join co on co.user_id = p.id
        left join ho on ho.user_id = p.id
        left join wl on wl.user_id = p.id
        left join lo on lo.user_id = p.id), '[]'::jsonb),
    'counts', jsonb_build_object(
      'profiles',          (select count(*) from profiles),
      'portfolios',        (select count(*) from portfolios),
      'transactions',      (select count(*) from transactions),
      'coach_messages',    (select count(*) from coach_messages),
      'holdings',          (select count(*) from holdings),
      'watchlist',         (select count(*) from watchlist),
      'limit_orders',      (select count(*) from limit_orders),
      'ai_response_cache', (select count(*) from ai_response_cache),
      'quote_cache',       (select count(*) from quote_cache),
      'dhan_instruments',  (select count(*) from dhan_instruments),
      'admin_audit_log',   (select count(*) from admin_audit_log),
      'portfolio_history', (select count(*) from portfolio_history)));
$$;

revoke all on function public.admin_overview() from public, anon, authenticated;
grant execute on function public.admin_overview() to service_role;

-- 2. Live tail: every event after p_since across the five feeds, oldest
--    first, in the same {kind, ts, userId, payload} shape as
--    op=admin-activity-feed. Slim columns only (no coach payload text).
create or replace function public.admin_tail_since(p_since timestamptz, p_limit int default 200)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(s.e order by s.ts), '[]'::jsonb)
    from (
      select u.e, u.ts from (
        select jsonb_build_object('kind', 'trade', 'ts', t.created_at, 'userId', t.user_id,
                 'payload', jsonb_build_object('id', t.id, 'user_id', t.user_id, 'symbol', t.symbol,
                   'side', t.side, 'qty', t.qty, 'price_paise', t.price_paise,
                   'value_paise', t.value_paise, 'created_at', t.created_at)) as e, t.created_at as ts
          from transactions t where t.created_at > p_since
        union all
        select jsonb_build_object('kind', 'coach', 'ts', c.created_at, 'userId', c.user_id,
                 'payload', jsonb_build_object('id', c.id, 'user_id', c.user_id, 'event_type', c.event_type,
                   'trigger_symbol', c.trigger_symbol, 'model', c.model, 'created_at', c.created_at)), c.created_at
          from coach_messages c where c.created_at > p_since
        union all
        select jsonb_build_object('kind', 'order', 'ts', o.created_at, 'userId', o.user_id,
                 'payload', jsonb_build_object('id', o.id, 'user_id', o.user_id, 'symbol', o.symbol,
                   'side', o.side, 'qty', o.qty, 'status', o.status, 'order_type', o.order_type,
                   'created_at', o.created_at)), o.created_at
          from limit_orders o where o.created_at > p_since
        union all
        select jsonb_build_object('kind', 'signup', 'ts', p.created_at, 'userId', p.id,
                 'payload', jsonb_build_object('id', p.id, 'username', p.username,
                   'display_name', p.display_name, 'created_at', p.created_at)), p.created_at
          from profiles p where p.created_at > p_since
        union all
        select jsonb_build_object('kind', 'admin', 'ts', a.ts, 'userId', a.target_user_id,
                 'payload', jsonb_build_object('id', a.id, 'action', a.action, 'reason', a.reason,
                   'target_kind', a.target_kind, 'target_user_id', a.target_user_id, 'ts', a.ts)), a.ts
          from admin_audit_log a where a.ts > p_since
      ) u
      order by u.ts asc
      limit greatest(1, least(coalesce(p_limit, 200), 500))
    ) s;
$$;

revoke all on function public.admin_tail_since(timestamptz, int) from public, anon, authenticated;
grant execute on function public.admin_tail_since(timestamptz, int) to service_role;
