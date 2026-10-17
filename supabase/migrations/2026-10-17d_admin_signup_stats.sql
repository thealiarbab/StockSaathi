-- Admin "Signups" tab: every signup number in one call.
--
-- All day/hour buckets are Indian time (Asia/Kolkata). Series are sent as a
-- start label plus a plain array of counts (zeros included), so a 30-day
-- hourly series is ~2 KB instead of 720 labelled objects.
--
-- security definer: it reads auth.users (email confirmed, Google vs email).
-- Only service_role (the admin API) may call it.

create or replace function public.admin_signup_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with nowx as (
  select now() as n, (now() at time zone 'Asia/Kolkata') as nl
),
s as (
  select p.id, p.username, p.display_name, p.created_at as ts,
         (p.created_at at time zone 'Asia/Kolkata') as lt,
         coalesce(p.onboarded, false) as onboarded, p.age,
         nullif(btrim(p.school), '') as school, nullif(btrim(p.city), '') as city,
         nullif(btrim(p.risk_profile), '') as risk,
         u.email_confirmed_at is not null as confirmed,
         coalesce(u.raw_app_meta_data->>'provider', 'email') as provider,
         nullif(lower(split_part(coalesce(u.email, p.email), '@', 2)), '') as domain
    from profiles p
    left join auth.users u on u.id = p.id
),
traded  as (select distinct user_id from transactions),
coached as (select distinct user_id from coach_messages),
-- Came back on a later Indian-time day than the one they signed up on.
seen as (
  select user_id, day from user_event_rollup
  union
  select user_id, (occurred_at at time zone 'Asia/Kolkata')::date from user_events where user_id is not null
),
returned as (
  select distinct seen.user_id from seen join s on s.id = seen.user_id where seen.day > s.lt::date
),
days as (
  select d::date as day
    from nowx, generate_series((select min(lt)::date from s), nowx.nl::date, interval '1 day') d
),
daily as (
  select days.day, count(s.id) as n from days left join s on s.lt::date = days.day group by days.day
),
hours as (
  select h from nowx,
    generate_series(date_trunc('hour', nl) - interval '719 hours', date_trunc('hour', nl), interval '1 hour') h
),
hourly as (
  select hours.h, count(s.id) as n from hours left join s on date_trunc('hour', s.lt) = hours.h group by hours.h
),
allhours as (
  select date_trunc('hour', lt) as h, count(*) as n from s group by 1
),
win as (
  select w.k, w.ord,
         count(s.id) filter (where s.ts > nowx.n - w.iv) as cur,
         count(s.id) filter (where s.ts > nowx.n - 2 * w.iv and s.ts <= nowx.n - w.iv) as prev
    from (values ('1h', interval '1 hour', 1), ('6h', interval '6 hours', 2), ('24h', interval '24 hours', 3),
                 ('48h', interval '48 hours', 4), ('7d', interval '7 days', 5), ('30d', interval '30 days', 6),
                 ('90d', interval '90 days', 7)) w(k, iv, ord)
    cross join nowx
    left join s on true
   group by w.k, w.ord
),
-- Best rolling windows ever: for each signup, how many in the window ending at it.
roll as (
  select ts,
         count(*) over (order by ts range between interval '1 hour'   preceding and current row) as r1h,
         count(*) over (order by ts range between interval '24 hours' preceding and current row) as r24h,
         count(*) over (order by ts range between interval '7 days'   preceding and current row) as r7d
    from s
),
ev as (
  select day, count(distinct user_id) as dau from seen
   where day > (select nl::date from nowx) - 90 group by day
),
pv as (
  select (occurred_at at time zone 'Asia/Kolkata')::date as day, count(*) as n
    from user_events where kind = 'page_view' and occurred_at > now() - interval '91 days' group by 1
),
tx as (
  select (created_at at time zone 'Asia/Kolkata')::date as day, count(*) as n, count(distinct user_id) as u
    from transactions where created_at > now() - interval '91 days' group by 1
),
co as (
  select (created_at at time zone 'Asia/Kolkata')::date as day, count(*) as n
    from coach_messages where created_at > now() - interval '91 days' group by 1
),
d90 as (
  select d::date as day from nowx, generate_series(nowx.nl::date - 89, nowx.nl::date, interval '1 day') d
)
select jsonb_build_object(
  'now', (select n from nowx),
  'nowIst', (select to_char(nl, 'YYYY-MM-DD"T"HH24:MI:SS') from nowx),
  'totals', (select jsonb_build_object(
      'total', count(*),
      'confirmed', count(*) filter (where confirmed),
      'google', count(*) filter (where provider = 'google'),
      'emailProvider', count(*) filter (where provider <> 'google'),
      'onboarded', count(*) filter (where onboarded),
      'traded', count(*) filter (where id in (select user_id from traded)),
      'coached', count(*) filter (where id in (select user_id from coached)),
      'returned', count(*) filter (where id in (select user_id from returned)),
      'firstAt', min(ts), 'lastAt', max(ts)) from s),
  'windows', (select jsonb_object_agg(k, jsonb_build_array(cur, prev)) from win),
  'calendar', (select jsonb_build_object(
      'today',              count(*) filter (where lt::date = nl::date),
      'yesterday',          count(*) filter (where lt::date = nl::date - 1),
      'yesterdaySameTime',  count(*) filter (where lt::date = nl::date - 1 and lt::time <= nl::time),
      'weekAgoDay',         count(*) filter (where lt::date = nl::date - 7),
      'weekAgoSameTime',    count(*) filter (where lt::date = nl::date - 7 and lt::time <= nl::time),
      'thisWeek',           count(*) filter (where lt >= date_trunc('week', nl)),
      'lastWeek',           count(*) filter (where lt >= date_trunc('week', nl) - interval '7 days' and lt < date_trunc('week', nl)),
      'lastWeekToDate',     count(*) filter (where lt >= date_trunc('week', nl) - interval '7 days' and lt <= nl - interval '7 days'),
      'thisMonth',          count(*) filter (where lt >= date_trunc('month', nl)),
      'lastMonth',          count(*) filter (where lt >= date_trunc('month', nl) - interval '1 month' and lt < date_trunc('month', nl)),
      'lastMonthToDate',    count(*) filter (where lt >= date_trunc('month', nl) - interval '1 month' and lt <= nl - interval '1 month'))
    from s, nowx),
  'daily', (select jsonb_build_object('start', min(day), 'n', jsonb_agg(n order by day)) from daily),
  'hourly', (select jsonb_build_object('start', to_char(min(h), 'YYYY-MM-DD"T"HH24:00'), 'n', jsonb_agg(n order by h)) from hourly),
  'topDays', (select coalesce(jsonb_agg(jsonb_build_array(day, n) order by n desc, day desc), '[]')
                from (select day, n from daily order by n desc, day desc limit 10) t),
  'topHours', (select coalesce(jsonb_agg(jsonb_build_array(to_char(h, 'YYYY-MM-DD"T"HH24:00'), n) order by n desc, h desc), '[]')
                from (select h, n from allhours order by n desc, h desc limit 10) t),
  'records', (select jsonb_build_object(
      'best1h',  (select jsonb_build_array(r1h,  ts) from roll order by r1h  desc, ts desc limit 1),
      'best24h', (select jsonb_build_array(r24h, ts) from roll order by r24h desc, ts desc limit 1),
      'best7d',  (select jsonb_build_array(r7d,  ts) from roll order by r7d  desc, ts desc limit 1))),
  'hourOfDay', (select jsonb_agg(n order by hr) from (
      select hr, count(s.id) as n from generate_series(0, 23) hr
        left join s on extract(hour from s.lt) = hr group by hr) t),
  'hourOfDay7d', (select jsonb_agg(n order by hr) from (
      select hr, count(s.id) as n from generate_series(0, 23) hr
        left join s on extract(hour from s.lt) = hr and s.ts > now() - interval '7 days' group by hr) t),
  'weekday', (select jsonb_agg(n order by dw) from (
      select dw, count(s.id) as n from generate_series(1, 7) dw
        left join s on extract(isodow from s.lt) = dw group by dw) t),
  -- 7 rows (Mon..Sun) x 24 hours, last 30 days.
  'heat', (select jsonb_agg(n order by dw, hr) from (
      select dw, hr, count(s.id) as n
        from generate_series(1, 7) dw cross join generate_series(0, 23) hr
        left join s on extract(isodow from s.lt) = dw and extract(hour from s.lt) = hr
                   and s.ts > now() - interval '30 days'
       group by dw, hr) t),
  'schools', (select coalesce(jsonb_agg(jsonb_build_array(k, n) order by n desc, k), '[]') from (
      select max(school) as k, count(*) as n from s where school is not null
       group by lower(school) order by 2 desc, 1 limit 10) t),
  'cities', (select coalesce(jsonb_agg(jsonb_build_array(k, n) order by n desc, k), '[]') from (
      select max(city) as k, count(*) as n from s where city is not null
       group by lower(city) order by 2 desc, 1 limit 10) t),
  'domains', (select coalesce(jsonb_agg(jsonb_build_array(k, n) order by n desc, k), '[]') from (
      select domain as k, count(*) as n from s where domain is not null
       group by domain order by 2 desc, 1 limit 10) t),
  'ages', (select coalesce(jsonb_agg(jsonb_build_array(k, n) order by o), '[]') from (
      select case when age is null then 'not given' when age < 13 then 'under 13'
                  when age > 22 then '23+' else age::text end as k,
             min(coalesce(age, 999)) as o, count(*) as n
        from s group by 1) t),
  'risk', (select coalesce(jsonb_agg(jsonb_build_array(k, n) order by n desc), '[]') from (
      select coalesce(risk, 'not set') as k, count(*) as n from s group by 1) t),
  'activity', (select jsonb_build_object(
      'start', min(d90.day),
      'dau',   jsonb_agg(coalesce(ev.dau, 0) order by d90.day),
      'views', jsonb_agg(coalesce(pv.n, 0)  order by d90.day),
      'trades', jsonb_agg(coalesce(tx.n, 0) order by d90.day),
      'traders', jsonb_agg(coalesce(tx.u, 0) order by d90.day),
      'coach', jsonb_agg(coalesce(co.n, 0)  order by d90.day))
    from d90
    left join ev on ev.day = d90.day
    left join pv on pv.day = d90.day
    left join tx on tx.day = d90.day
    left join co on co.day = d90.day),
  'recent', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'username', username, 'name', display_name, 'ts', ts, 'school', school, 'city', city,
      'age', age, 'provider', provider, 'confirmed', confirmed, 'onboarded', onboarded) order by ts desc), '[]')
    from (select * from s order by ts desc limit 50) t)
);
$$;

revoke all on function public.admin_signup_stats() from public, anon, authenticated;
grant execute on function public.admin_signup_stats() to service_role;
