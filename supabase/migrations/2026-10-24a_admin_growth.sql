-- /a "Growth" tab: retention by sign-up week, time to first trade, and
-- feature adoption. Read-only over existing tables; service_role only.
-- "Active" on a day = any user_events row (it logs every signed-in page view), IST.
-- web_events is not scanned: it is too large to aggregate per call.

create or replace function public.admin_growth(p_weeks int default 12)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with params as (
    select (now() at time zone 'Asia/Kolkata')::date as today,
           ((now() at time zone 'Asia/Kolkata')::date - (least(greatest(p_weeks, 1), 52) * 7)) as start_day
  ),
  users as (
    select p.id, (p.created_at at time zone 'Asia/Kolkata')::date as d0, p.created_at
    from public.profiles p, params
    where (p.created_at at time zone 'Asia/Kolkata')::date >= params.start_day
  ),
  act as (
    select distinct u.id, (e.occurred_at at time zone 'Asia/Kolkata')::date - u.d0 as dn
    from users u join public.user_events e on e.user_id = u.id and e.occurred_at >= u.created_at
  ),
  per_user as (
    select u.id, u.d0, u.created_at,
      bool_or(a.dn = 1) as r1,
      bool_or(a.dn between 7 and 13) as r7,
      bool_or(a.dn between 30 and 36) as r30,
      count(distinct a.dn) filter (where a.dn between 0 and 29) as days_active_30,
      (select min(t.created_at) from public.transactions t where t.user_id = u.id) as first_trade
    from users u left join act a on a.id = u.id
    group by u.id, u.d0, u.created_at
  ),
  cohorts as (
    select date_trunc('week', d0)::date as week,
      count(*) as signups,
      count(*) filter (where first_trade is not null) as traded,
      count(*) filter (where first_trade < created_at + interval '1 hour') as traded_1h,
      count(*) filter (where first_trade < created_at + interval '1 day') as traded_1d,
      round(100.0 * count(*) filter (where r1 and d0 + 1 <= (select today from params) - 1) / nullif(count(*) filter (where d0 + 1 <= (select today from params) - 1), 0), 1) as d1_pct,
      round(100.0 * count(*) filter (where r7 and d0 + 13 <= (select today from params) - 1) / nullif(count(*) filter (where d0 + 13 <= (select today from params) - 1), 0), 1) as d7_pct,
      round(100.0 * count(*) filter (where r30 and d0 + 36 <= (select today from params) - 1) / nullif(count(*) filter (where d0 + 36 <= (select today from params) - 1), 0), 1) as d30_pct,
      percentile_disc(0.5) within group (order by extract(epoch from first_trade - created_at) / 60)
        filter (where first_trade is not null) as median_min_to_first_trade
    from per_user group by 1
  ),
  -- What did the users who came back do in their first day?
  first_day as (
    select pu.id, pu.r7,
      exists (select 1 from public.transactions t where t.user_id = pu.id and t.created_at < pu.created_at + interval '1 day') as trade,
      exists (select 1 from public.coach_messages c where c.user_id = pu.id and c.event_type = 'chat_user' and c.created_at < pu.created_at + interval '1 day') as coach,
      exists (select 1 from public.user_events e where e.user_id = pu.id and e.kind = 'replay_start' and e.occurred_at < pu.created_at + interval '1 day') as time_travel,
      exists (select 1 from public.user_events e where e.user_id = pu.id and e.kind = 'watchlist_add' and e.occurred_at < pu.created_at + interval '1 day') as watchlist,
      exists (select 1 from public.limit_orders o where o.user_id = pu.id and o.created_at < pu.created_at + interval '1 day') as limit_order
    from per_user pu where pu.d0 + 13 <= (select today from params) - 1
  ),
  win as (
    select x.days, now() - make_interval(days => x.days) as since from (values (7), (30)) x(days)
  ),
  actives as (
    select w.days, count(distinct e.user_id) as n from win w join public.user_events e on e.occurred_at >= w.since group by w.days
  ),
  adoption as (
    select w.days,
      (select n from actives a where a.days = w.days) as active_users,
      (select count(distinct c.user_id) from public.coach_messages c where c.event_type = 'chat_user' and c.created_at >= w.since) as coach,
      (select count(distinct c.user_id) from public.coach_messages c where c.event_type = 'chat_user' and c.surface = 'chat_page' and c.created_at >= w.since) as coach_chat_page,
      (select count(distinct c.user_id) from public.coach_messages c where c.event_type = 'chat_user' and c.surface = 'side_panel' and c.created_at >= w.since) as coach_side_panel,
      (select count(distinct t.user_id) from public.transactions t where t.created_at >= w.since) as traded,
      (select count(distinct e.user_id) from public.user_events e where e.kind = 'replay_start' and e.occurred_at >= w.since) as time_travel,
      (select count(distinct e.user_id) from public.user_events e where e.kind = 'replay_finish' and e.occurred_at >= w.since) as time_travel_finished,
      (select count(distinct o.user_id) from public.limit_orders o where coalesce(o.order_type, 'LIMIT') = 'LIMIT' and o.created_at >= w.since) as limit_orders,
      (select count(distinct o.user_id) from public.limit_orders o where o.order_type = 'AMO_MARKET' and o.created_at >= w.since) as amo_orders,
      (select count(distinct o.user_id) from public.limit_orders o where o.order_type = 'MF' and o.created_at >= w.since) as mutual_funds,
      (select count(distinct e.user_id) from public.user_events e where e.kind = 'page_view' and e.subject = '/report-card' and e.occurred_at >= w.since) as report_card,
      (select count(distinct e.user_id) from public.user_events e where e.kind = 'page_view' and e.subject = '/news' and e.occurred_at >= w.since) as news,
      (select count(distinct e.user_id) from public.user_events e where e.kind = 'watchlist_add' and e.occurred_at >= w.since) as watchlist,
      (select count(distinct p.user_id) from public.chat_projects p where p.created_at >= w.since) as chat_projects,
      (select count(distinct f.user_id) from public.chat_feedback f where f.created_at >= w.since) as gave_feedback
    from win w
  )
  select jsonb_build_object(
    'cohorts', coalesce((select jsonb_agg(c order by c.week desc) from cohorts c), '[]'::jsonb),
    'first_day', (select jsonb_build_object(
        'retained', jsonb_build_object('n', count(*) filter (where r7),
          'trade', round(100.0 * count(*) filter (where r7 and trade) / nullif(count(*) filter (where r7), 0), 1),
          'coach', round(100.0 * count(*) filter (where r7 and coach) / nullif(count(*) filter (where r7), 0), 1),
          'time_travel', round(100.0 * count(*) filter (where r7 and time_travel) / nullif(count(*) filter (where r7), 0), 1),
          'watchlist', round(100.0 * count(*) filter (where r7 and watchlist) / nullif(count(*) filter (where r7), 0), 1),
          'limit_order', round(100.0 * count(*) filter (where r7 and limit_order) / nullif(count(*) filter (where r7), 0), 1)),
        'churned', jsonb_build_object('n', count(*) filter (where not coalesce(r7, false)),
          'trade', round(100.0 * count(*) filter (where not coalesce(r7, false) and trade) / nullif(count(*) filter (where not coalesce(r7, false)), 0), 1),
          'coach', round(100.0 * count(*) filter (where not coalesce(r7, false) and coach) / nullif(count(*) filter (where not coalesce(r7, false)), 0), 1),
          'time_travel', round(100.0 * count(*) filter (where not coalesce(r7, false) and time_travel) / nullif(count(*) filter (where not coalesce(r7, false)), 0), 1),
          'watchlist', round(100.0 * count(*) filter (where not coalesce(r7, false) and watchlist) / nullif(count(*) filter (where not coalesce(r7, false)), 0), 1),
          'limit_order', round(100.0 * count(*) filter (where not coalesce(r7, false) and limit_order) / nullif(count(*) filter (where not coalesce(r7, false)), 0), 1))
      ) from first_day),
    'adoption', coalesce((select jsonb_agg(a order by a.days) from adoption a), '[]'::jsonb)
  );
$$;
revoke all on function public.admin_growth(int) from public, anon, authenticated;
grant execute on function public.admin_growth(int) to service_role;
