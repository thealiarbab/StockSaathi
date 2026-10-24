-- Admin → Behaviour tab timed out (HTTP 502) once web_events passed ~600k
-- rows in 7 days: the old function materialised every event (props and all)
-- into one CTE and re-read it ~100 times with 2 MB of work_mem — 24 times
-- for the hourly chart alone, once per error type for the browser list.
--
-- Same output, built differently:
--   w   — materialised, without props (the bulky column), for the wide stats.
--   wp  — NOT MATERIALIZED, so each section's kind filter reaches the
--         (kind, ts) index and only reads its own events, props included.
--   hourly is one GROUP BY; error browsers come from the error rows only.
create or replace function public.admin_behaviour_stats(p_days integer default 7)
returns jsonb language sql stable security definer
set search_path = public
set work_mem = '32MB'
as $$
with prm as (select greatest(1, least(coalesce(p_days, 7), 90)) as d),
w as materialized (
  select e.sid, e.vid, e.uid, e.ts, e.kind, e.target, web_path_group(e.path) as pp
    from web_events e, prm where e.ts > now() - make_interval(days => prm.d)
),
wp as not materialized (
  select e.sid, e.vid, e.ts, e.kind, e.target, e.props, web_path_group(e.path) as pp
    from web_events e, prm where e.ts > now() - make_interval(days => prm.d)
),
sess as (
  select sid, min(vid) as vid, bool_or(uid is not null) as signed_in, min(ts) as t0, max(ts) as t1,
         count(*) filter (where kind = 'page') as pages, count(*) filter (where kind = 'click') as clicks
    from w group by sid
),
ss as materialized (select * from wp where kind = 'session_start'),
errs as materialized (select * from wp where kind = 'error'),
days as (
  select g::date as day from prm, generate_series((now() at time zone 'Asia/Kolkata')::date - (prm.d - 1),
                                                   (now() at time zone 'Asia/Kolkata')::date, interval '1 day') g
),
-- t1 = the session's last event of any kind, carried along so "live" needs no
-- join back to w (that semi-join was planned as a nested loop: 49 s alone).
last_page as (
  select distinct on (sid) sid, pp, t1
    from (select sid, pp, ts, kind, max(ts) over (partition by sid) as t1 from w) x
   where kind = 'page' order by sid, ts desc
)
select jsonb_build_object(
  'days', (select d from prm),
  'live', (select jsonb_build_object(
      'sessions5m', count(distinct sid) filter (where ts > now() - interval '5 minutes'),
      'visitors30m', count(distinct vid) filter (where ts > now() - interval '30 minutes'),
      'pages', coalesce((select jsonb_agg(jsonb_build_array(pp, n) order by n desc) from (
          select pp, count(*) as n from last_page where t1 > now() - interval '5 minutes'
           group by pp order by 2 desc limit 10) t), '[]'::jsonb))
    from w),
  'totals', (select jsonb_build_object(
      'events', (select count(*) from w),
      'sessions', count(*),
      'visitors', count(distinct vid),
      'signedInSessions', count(*) filter (where signed_in),
      'avgSessionSec', round(avg(extract(epoch from (t1 - t0)))::numeric, 1),
      'medianSessionSec', round((percentile_cont(0.5) within group (order by extract(epoch from (t1 - t0))))::numeric, 1),
      'pagesPerSession', round(avg(pages)::numeric, 2),
      'bouncePct', round(100.0 * count(*) filter (where pages <= 1 and clicks = 0) / greatest(1, count(*)), 1))
    from sess),
  'daily', (select coalesce(jsonb_agg(jsonb_build_array(days.day, coalesce(x.sessions, 0), coalesce(x.visitors, 0),
                     coalesce(x.signed, 0), coalesce(x.avgsec, 0), coalesce(x.pps, 0)) order by days.day), '[]'::jsonb)
    from days left join (
      select (t0 at time zone 'Asia/Kolkata')::date as day, count(*) as sessions, count(distinct vid) as visitors,
             count(distinct vid) filter (where signed_in) as signed,
             round(avg(extract(epoch from (t1 - t0)))::numeric, 0) as avgsec, round(avg(pages)::numeric, 2) as pps
        from sess group by 1) x on x.day = days.day),
  'hourly', (select jsonb_agg(coalesce(x.n, 0) order by h) from generate_series(0, 23) h left join (
      select extract(hour from ts at time zone 'Asia/Kolkata')::int as hr, count(distinct sid) as n
        from w group by 1) x on x.hr = h),
  'funnel', (select jsonb_build_object(
      'visitors', count(distinct vid),
      'sawRegister', count(distinct vid) filter (where kind = 'page' and pp in ('/register', '/signup')),
      'clickedGoogle', count(distinct vid) filter (where kind = 'click' and target ilike '%google%' and pp in ('/register', '/login', '/signup', '')),
      'startedForm', count(distinct vid) filter (where kind = 'form_start' and target = 'reg-form'),
      'submittedForm', count(distinct vid) filter (where kind = 'form_submit' and target = 'reg-form'),
      'sawCode', count(distinct vid) filter (where kind = 'form_start' and target = 'otp-form'),
      'submittedCode', count(distinct vid) filter (where kind = 'form_submit' and target = 'otp-form'),
      'signedUp', (select count(*) from web_visitors v join profiles p on p.id = v.uid, prm
                    where p.created_at > now() - make_interval(days => prm.d)
                      and p.created_at >= v.first_seen - interval '2 minutes'),
      'reachedOnboarding', count(distinct vid) filter (where kind = 'page' and pp = '/onboarding'))
    from w),
  'sources', (select coalesce(jsonb_agg(jsonb_build_array(src, visitors, signups) order by visitors desc), '[]'::jsonb) from (
      select coalesce(nullif(v.first_touch->>'src', ''), 'direct') as src, count(*) as visitors,
             count(*) filter (where p.id is not null and p.created_at >= v.first_seen - interval '2 minutes') as signups
        from web_visitors v left join profiles p on p.id = v.uid, prm
       where v.first_seen > now() - make_interval(days => prm.d)
       group by 1 order by 2 desc limit 25) t),
  'campaigns', (select coalesce(jsonb_agg(jsonb_build_array(c, visitors, signups) order by visitors desc), '[]'::jsonb) from (
      select concat_ws(' / ', v.first_touch->>'us', v.first_touch->>'um', v.first_touch->>'uc') as c, count(*) as visitors,
             count(*) filter (where p.id is not null) as signups
        from web_visitors v left join profiles p on p.id = v.uid, prm
       where v.first_seen > now() - make_interval(days => prm.d) and v.first_touch ? 'us'
       group by 1 order by 2 desc limit 20) t),
  'landing', (select coalesce(jsonb_agg(jsonb_build_array(pp, n) order by n desc), '[]'::jsonb) from (
      select pp, count(*) as n from ss group by pp order by 2 desc limit 15) t),
  'exits', (select coalesce(jsonb_agg(jsonb_build_array(pp, n) order by n desc), '[]'::jsonb) from (
      select pp, count(*) as n from last_page group by pp order by 2 desc limit 15) t),
  'pages', (select coalesce(jsonb_agg(jsonb_build_array(pp, views, visitors, avgsec, avgscroll, reach75) order by views desc), '[]'::jsonb) from (
      select pp,
             count(*) filter (where kind = 'page') as views,
             count(distinct vid) filter (where kind = 'page') as visitors,
             round((avg(web_num(props->>'ms')) filter (where kind = 'page_leave')) / 1000, 1) as avgsec,
             round(avg(web_num(props->>'sd')) filter (where kind = 'page_leave'), 0) as avgscroll,
             round(100.0 * count(*) filter (where kind = 'page_leave' and web_num(props->>'sd') >= 75)
                   / greatest(1, count(*) filter (where kind = 'page_leave')), 0) as reach75
        from wp where kind in ('page', 'page_leave') group by pp order by 2 desc limit 30) t),
  'clicks', (select coalesce(jsonb_agg(jsonb_build_array(pp, target, n, visitors) order by n desc), '[]'::jsonb) from (
      select pp, target, count(*) as n, count(distinct vid) as visitors
        from w where kind = 'click' group by 1, 2 order by 3 desc limit 60) t),
  'rage', (select coalesce(jsonb_agg(jsonb_build_array(pp, target, n, visitors) order by n desc), '[]'::jsonb) from (
      select pp, target, count(*) as n, count(distinct vid) as visitors
        from w where kind = 'rage_click' group by 1, 2 order by 3 desc limit 25) t),
  'deadClicks', (select coalesce(jsonb_agg(jsonb_build_array(pp, target, n) order by n desc), '[]'::jsonb) from (
      select pp, target, count(*) as n from wp where kind = 'click' and (props->>'dead') = '1'
       group by 1, 2 order by 3 desc limit 25) t),
  'outbound', (select coalesce(jsonb_agg(jsonb_build_array(target, n) order by n desc), '[]'::jsonb) from (
      select target, count(*) as n from w where kind = 'outbound' group by 1 order by 2 desc limit 20) t),
  'errors', (select coalesce(jsonb_agg(jsonb_build_array(target, n, sessions, last, page, src, browsers) order by n desc), '[]'::jsonb) from (
      select target, count(*) as n, count(distinct sid) as sessions, max(ts) as last,
             mode() within group (order by pp) as page,
             mode() within group (order by props->>'src') as src,
             (select string_agg(b, ', ') from (select distinct props->>'br' as b from errs e2 where e2.target = e.target limit 4) bb) as browsers
        from errs e group by target order by 2 desc limit 40) t),
  'api', (select coalesce(jsonb_agg(jsonb_build_array(target, st, n, avgms, p90ms) order by n desc), '[]'::jsonb) from (
      select target, coalesce(props->>'st', '?') as st, count(*) as n,
             round(avg(web_num(props->>'ms')), 0) as avgms,
             round((percentile_cont(0.9) within group (order by web_num(props->>'ms')))::numeric, 0) as p90ms
        from wp where kind = 'api' group by 1, 2 order by 3 desc limit 40) t),
  'searches', (select coalesce(jsonb_agg(jsonb_build_array(q, n, visitors, zero, src) order by n desc), '[]'::jsonb) from (
      select lower(target) as q, count(*) as n, count(distinct vid) as visitors,
             count(*) filter (where (props->>'res') = '0') as zero,
             mode() within group (order by props->>'in') as src
        from wp where kind = 'search' and coalesce(target, '') <> '' group by 1 order by 2 desc limit 60) t),
  'zeroSearches', (select coalesce(jsonb_agg(jsonb_build_array(q, n) order by n desc), '[]'::jsonb) from (
      select lower(target) as q, count(*) as n from wp
       where kind = 'search' and (props->>'res') = '0' and coalesce(target, '') <> ''
       group by 1 order by 2 desc limit 40) t),
  'forms', (select coalesce(jsonb_agg(jsonb_build_array(target, starts, submits, abandons) order by starts desc), '[]'::jsonb) from (
      select target,
             count(distinct sid) filter (where kind = 'form_start') as starts,
             count(distinct sid) filter (where kind = 'form_submit') as submits,
             count(distinct sid) filter (where kind = 'form_abandon') as abandons
        from w where kind in ('form_start', 'form_submit', 'form_abandon') group by target order by 2 desc limit 20) t),
  'abandonFields', (select coalesce(jsonb_agg(jsonb_build_array(target, field, n) order by n desc), '[]'::jsonb) from (
      select target, coalesce(props->>'last', '(none)') as field, count(*) as n
        from wp where kind = 'form_abandon' group by 1, 2 order by 3 desc limit 25) t),
  'fieldTimes', (select coalesce(jsonb_agg(jsonb_build_array(target, field, n, avgsec, emptyPct) order by n desc), '[]'::jsonb) from (
      select target, props->>'f' as field, count(*) as n,
             round(avg(web_num(props->>'ms')) / 1000, 1) as avgsec,
             round(100.0 * count(*) filter (where (props->>'filled') = '0') / greatest(1, count(*)), 0) as emptyPct
        from wp where kind = 'field' group by 1, 2 order by 3 desc limit 40) t),
  'formErrors', (select coalesce(jsonb_agg(jsonb_build_array(target, msg, n) order by n desc), '[]'::jsonb) from (
      select target, props->>'msg' as msg, count(*) as n
        from wp where kind = 'form_error' group by 1, 2 order by 3 desc limit 30) t),
  'toasts', (select coalesce(jsonb_agg(jsonb_build_array(k, target, n) order by n desc), '[]'::jsonb) from (
      select props->>'k' as k, target, count(*) as n from wp where kind = 'toast' group by 1, 2 order by 3 desc limit 30) t),
  'perf', (select coalesce(jsonb_agg(jsonb_build_array(pp, n, ttfb, fcp, lcp, cls, inp) order by n desc), '[]'::jsonb) from (
      select pp, count(*) as n,
             round((percentile_cont(0.75) within group (order by web_num(props->>'ttfb')))::numeric, 0) as ttfb,
             round((percentile_cont(0.75) within group (order by web_num(props->>'fcp')))::numeric, 0) as fcp,
             round((percentile_cont(0.75) within group (order by web_num(props->>'lcp')))::numeric, 0) as lcp,
             round((percentile_cont(0.75) within group (order by web_num(props->>'cls')))::numeric, 3) as cls,
             round((percentile_cont(0.75) within group (order by web_num(props->>'inp')))::numeric, 0) as inp
        from wp where kind = 'perf' group by pp order by 2 desc limit 20) t),
  'devices', (select jsonb_build_object(
      'dev', coalesce((select jsonb_agg(jsonb_build_array(k, n) order by n desc) from (select coalesce(props->>'dev', '?') as k, count(distinct vid) as n from ss group by 1 order by 2 desc limit 6) t), '[]'::jsonb),
      'os',  coalesce((select jsonb_agg(jsonb_build_array(k, n) order by n desc) from (select coalesce(props->>'os', '?') as k, count(distinct vid) as n from ss group by 1 order by 2 desc limit 8) t), '[]'::jsonb),
      'br',  coalesce((select jsonb_agg(jsonb_build_array(k, n) order by n desc) from (select coalesce(props->>'br', '?') as k, count(distinct vid) as n from ss group by 1 order by 2 desc limit 8) t), '[]'::jsonb),
      'scr', coalesce((select jsonb_agg(jsonb_build_array(k, n) order by n desc) from (select coalesce(props->>'scr', '?') as k, count(distinct vid) as n from ss group by 1 order by 2 desc limit 12) t), '[]'::jsonb),
      'lang', coalesce((select jsonb_agg(jsonb_build_array(k, n) order by n desc) from (select coalesce(props->>'lang', '?') as k, count(distinct vid) as n from ss group by 1 order by 2 desc limit 8) t), '[]'::jsonb),
      'net', coalesce((select jsonb_agg(jsonb_build_array(k, n) order by n desc) from (select coalesce(props->>'net', '?') as k, count(distinct vid) as n from ss group by 1 order by 2 desc limit 6) t), '[]'::jsonb),
      'theme', coalesce((select jsonb_agg(jsonb_build_array(k, n) order by n desc) from (select coalesce(props->>'th', '?') as k, count(distinct vid) as n from ss group by 1 order by 2 desc limit 4) t), '[]'::jsonb),
      'pwa', coalesce((select jsonb_agg(jsonb_build_array(k, n) order by n desc) from (select coalesce(props->>'pwa', '0') as k, count(distinct vid) as n from ss group by 1 order by 2 desc) t), '[]'::jsonb),
      'cc',  coalesce((select jsonb_agg(jsonb_build_array(k, n) order by n desc) from (select coalesce(props->>'cc', '?') as k, count(distinct vid) as n from ss group by 1 order by 2 desc limit 10) t), '[]'::jsonb))),
  'other', (select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) from (
      select kind, count(*) as n from w group by kind) t)
);
$$;

revoke all on function public.admin_behaviour_stats(integer) from public, anon, authenticated;
grant execute on function public.admin_behaviour_stats(integer) to service_role;

-- Even fixed, the 7-day pass reads ~640k raw events (never deleted, owner's
-- decision) and the database is a small shared-CPU instance: 30-60 s. So the
-- tab no longer computes on load. pg_cron refreshes one stored result per
-- range in the background; the tab reads it, plus a live panel computed from
-- the last few hours only.
create table if not exists public.admin_behaviour_cache (
  days        integer primary key,
  data        jsonb not null,
  computed_at timestamptz not null,
  ms          integer
);
alter table public.admin_behaviour_cache enable row level security;
revoke all on table public.admin_behaviour_cache from anon, authenticated;

-- Refreshes every range that is due: 24 h every 10 min, 7 days every 30 min,
-- 30 and 90 days daily. p_force recomputes all four.
create or replace function public.refresh_admin_behaviour(p_force boolean default false)
returns integer language plpgsql security definer
set search_path = public
as $$
declare d integer; t0 timestamptz; j jsonb; n integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('refresh_admin_behaviour')) then return -1; end if;
  foreach d in array array[1, 7, 30, 90] loop
    if p_force or not exists (
         select 1 from admin_behaviour_cache c where c.days = d
            and c.computed_at > clock_timestamp() - case d when 1 then interval '9 minutes'
                                                          when 7 then interval '29 minutes'
                                                          else interval '23 hours' end) then
      t0 := clock_timestamp();
      j := admin_behaviour_stats(d);
      insert into admin_behaviour_cache (days, data, computed_at, ms)
      values (d, j, t0, round(extract(epoch from clock_timestamp() - t0) * 1000))
      on conflict (days) do update set data = excluded.data, computed_at = excluded.computed_at, ms = excluded.ms;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Live panel from the last 30 minutes (last page looked up within 6 hours).
create or replace function public.admin_behaviour_live()
returns jsonb language sql stable security definer
set search_path = public
as $$
with r as (select sid, vid, ts from web_events where ts > now() - interval '30 minutes'),
recent as (select distinct sid from r where ts > now() - interval '5 minutes'),
lp as (
  select distinct on (e.sid) e.sid, web_path_group(e.path) as pp
    from web_events e
   where e.kind = 'page' and e.ts > now() - interval '6 hours' and e.sid in (select sid from recent)
   order by e.sid, e.ts desc
)
select jsonb_build_object(
  'sessions5m', (select count(*) from recent),
  'visitors30m', (select count(distinct vid) from r),
  'pages', coalesce((select jsonb_agg(jsonb_build_array(pp, n) order by n desc) from (
      select pp, count(*) as n from lp group by pp order by 2 desc limit 10) t), '[]'::jsonb));
$$;

-- What the tab calls: the stored result for the smallest range covering
-- p_days, the live panel, and when the stored part was computed.
create or replace function public.admin_behaviour_cached(p_days integer default 7)
returns jsonb language sql stable security definer
set search_path = public
as $$
with k as (select case when coalesce(p_days, 7) <= 1 then 1 when p_days <= 7 then 7
                       when p_days <= 30 then 30 else 90 end as d)
select coalesce(c.data, jsonb_build_object('days', k.d))
       || jsonb_build_object('live', admin_behaviour_live(), 'asOf', c.computed_at,
                             'computeMs', c.ms, 'pending', c.days is null)
  from k left join admin_behaviour_cache c on c.days = k.d;
$$;

revoke all on function public.refresh_admin_behaviour(boolean) from public, anon, authenticated;
revoke all on function public.admin_behaviour_live() from public, anon, authenticated;
revoke all on function public.admin_behaviour_cached(integer) from public, anon, authenticated;
grant execute on function public.admin_behaviour_cached(integer) to service_role;

-- pg_cron has no per-job timeout setting; the role's default would cut the
-- 90-day pass short, so the command raises it for its own session.
select cron.schedule('behaviour-cache', '*/10 * * * *',
  $$set statement_timeout = '15min'; select public.refresh_admin_behaviour();$$);
