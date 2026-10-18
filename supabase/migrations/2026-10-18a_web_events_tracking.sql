-- Visitor and action tracking for everyone (signed in or not).
--
-- user_events only sees signed-in students and only a few actions. web_events
-- records every page, click, form step, error, search, scroll and timing from
-- every visitor, written by the /api/ai?op=ev endpoint (service role only; no
-- browser can read or write these tables directly).
--
-- Size: the free database is 500 MB and goes read-only when full, which would
-- stop the whole site saving. Raw rows are kept until web_events passes
-- 600,000 rows (roughly 250 MB with indexes); past that the
-- oldest raw rows go. Every day is first added into web_event_daily, which is
-- kept forever. user_events is not touched by any of this.
-- Field values typed by students are never recorded (search text excepted).

create table if not exists public.web_events (
  id          bigint generated always as identity primary key,
  ts          timestamptz not null,
  received_at timestamptz not null default now(),
  vid         text not null,        -- random visitor id kept in the browser
  sid         text not null,        -- session id (new after 30 min idle)
  uid         uuid,                 -- signed-in account (verified server side)
  kind        text not null,
  path        text,
  target      text,
  props       jsonb not null default '{}'::jsonb
);
create index if not exists web_events_ts_idx   on public.web_events (ts);
create index if not exists web_events_uid_idx  on public.web_events (uid, ts) where uid is not null;
create index if not exists web_events_vid_idx  on public.web_events (vid, ts);
create index if not exists web_events_kind_idx on public.web_events (kind, ts);
alter table public.web_events enable row level security;

-- One row per browser: first visit, where it came from, which account it became.
create table if not exists public.web_visitors (
  vid         text primary key,
  first_seen  timestamptz not null,
  first_touch jsonb not null default '{}'::jsonb,   -- landing, src, ref, utm, device, country
  uid         uuid,
  linked_at   timestamptz
);
create index if not exists web_visitors_uid_idx on public.web_visitors (uid);
create index if not exists web_visitors_first_idx on public.web_visitors (first_seen);
alter table public.web_visitors enable row level security;

create table if not exists public.web_event_daily (
  day      date not null,
  kind     text not null,
  path     text not null,
  target   text not null,
  n        integer not null,
  visitors integer not null,
  primary key (day, kind, path, target)
);
alter table public.web_event_daily enable row level security;

-- Numbers inside props come from browsers: read them without ever failing.
create or replace function public.web_num(t text)
returns numeric language sql immutable as $$
  select case when t ~ '^-?[0-9]{1,12}(\.[0-9]{1,6})?$' then t::numeric end;
$$;

-- Pattern used everywhere pages are grouped: one row for all stock pages.
create or replace function public.web_path_group(p text)
returns text language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''),
           '^/stocks/[^/]+$', '/stocks/:symbol'),
           '^/crash-replay/[^/]+$', '/crash-replay/:id'),
           '^/a/.*$', '/a/:admin');
$$;

-- Called by the endpoint with one batch. p_uid is the account the endpoint
-- verified from the session token (never taken from the browser's word).
create or replace function public.ingest_web_events(p jsonb, p_uid uuid default null, p_country text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  if jsonb_typeof(p) <> 'array' then return 0; end if;

  insert into web_events (ts, vid, sid, uid, kind, path, target, props)
  select least(coalesce(e.ts, now()), now()),
         left(e.vid, 40), left(e.sid, 40), p_uid,
         left(e.kind, 32), left(e.path, 300), left(e.target, 300),
         case when jsonb_typeof(e.props) = 'object' then e.props else '{}'::jsonb end
    from jsonb_to_recordset(p) as e(ts timestamptz, vid text, sid text, kind text, path text, target text, props jsonb)
   where e.vid is not null and e.sid is not null and e.kind is not null
     and e.ts > now() - interval '2 days';
  get diagnostics n = row_count;

  -- First session we see for a browser = its first touch.
  insert into web_visitors (vid, first_seen, first_touch)
  select distinct on (e.vid) left(e.vid, 40), least(coalesce(e.ts, now()), now()),
         (case when jsonb_typeof(e.props) = 'object' then e.props else '{}'::jsonb end)
           || jsonb_build_object('landing', left(e.path, 300))
           || jsonb_strip_nulls(jsonb_build_object('cc', p_country))
    from jsonb_to_recordset(p) as e(ts timestamptz, vid text, kind text, path text, props jsonb)
   where e.kind = 'session_start' and e.vid is not null
   order by e.vid, e.ts
  on conflict (vid) do nothing;

  if p_uid is not null then
    insert into web_visitors (vid, first_seen)
    select distinct left(e.vid, 40), now()
      from jsonb_to_recordset(p) as e(vid text) where e.vid is not null
    on conflict (vid) do nothing;
    update web_visitors v set uid = p_uid, linked_at = now()
     where v.uid is null
       and v.vid in (select distinct left(e.vid, 40) from jsonb_to_recordset(p) as e(vid text));
  end if;
  return n;
end $$;

-- Nightly: add the last two days into the daily table, then, only if the raw
-- table is over its row cap, drop its oldest rows down to the cap.
create or replace function public.roll_up_web_events(p_days integer default 2)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  insert into web_event_daily (day, kind, path, target, n, visitors)
  select (ts at time zone 'Asia/Kolkata')::date, kind, web_path_group(path),
         left(coalesce(target, ''), 200), count(*), count(distinct vid)
    from web_events
   where ts >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' - make_interval(days => p_days - 1)
   group by 1, 2, 3, 4
  on conflict (day, kind, path, target) do update set n = excluded.n, visitors = excluded.visitors;
  get diagnostics n = row_count;
  return n;
end $$;

-- Everything the admin Behaviour tab shows, in one call.
create or replace function public.admin_behaviour_stats(p_days integer default 7)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with prm as (select greatest(1, least(coalesce(p_days, 7), 90)) as d),
w as (
  select e.*, web_path_group(e.path) as pp, (e.ts at time zone 'Asia/Kolkata') as lt
    from web_events e, prm where e.ts > now() - make_interval(days => prm.d)
),
sess as (
  select sid, min(vid) as vid, bool_or(uid is not null) as signed_in, min(ts) as t0, max(ts) as t1,
         count(*) filter (where kind = 'page') as pages, count(*) filter (where kind = 'click') as clicks
    from w group by sid
),
ss as (select * from w where kind = 'session_start'),
days as (
  select g::date as day from prm, generate_series((now() at time zone 'Asia/Kolkata')::date - (prm.d - 1),
                                                   (now() at time zone 'Asia/Kolkata')::date, interval '1 day') g
),
last_page as (
  select distinct on (sid) sid, pp from w where kind = 'page' order by sid, ts desc
)
select jsonb_build_object(
  'days', (select d from prm),
  'live', (select jsonb_build_object(
      'sessions5m', count(distinct sid) filter (where ts > now() - interval '5 minutes'),
      'visitors30m', count(distinct vid) filter (where ts > now() - interval '30 minutes'),
      'pages', coalesce((select jsonb_agg(jsonb_build_array(pp, n) order by n desc) from (
          select l.pp, count(*) as n from last_page l
           where l.sid in (select sid from w where ts > now() - interval '5 minutes')
           group by l.pp order by 2 desc limit 10) t), '[]'::jsonb))
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
  'hourly', (select jsonb_agg(coalesce(n, 0) order by h) from (
      select h, (select count(distinct sid) from w where extract(hour from lt) = h) as n from generate_series(0, 23) h) t),
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
        from w where kind in ('page', 'page_leave') group by pp order by 2 desc limit 30) t),
  'clicks', (select coalesce(jsonb_agg(jsonb_build_array(pp, target, n, visitors) order by n desc), '[]'::jsonb) from (
      select pp, target, count(*) as n, count(distinct vid) as visitors
        from w where kind = 'click' group by 1, 2 order by 3 desc limit 60) t),
  'rage', (select coalesce(jsonb_agg(jsonb_build_array(pp, target, n, visitors) order by n desc), '[]'::jsonb) from (
      select pp, target, count(*) as n, count(distinct vid) as visitors
        from w where kind = 'rage_click' group by 1, 2 order by 3 desc limit 25) t),
  'deadClicks', (select coalesce(jsonb_agg(jsonb_build_array(pp, target, n) order by n desc), '[]'::jsonb) from (
      select pp, target, count(*) as n from w where kind = 'click' and (props->>'dead') = '1'
       group by 1, 2 order by 3 desc limit 25) t),
  'outbound', (select coalesce(jsonb_agg(jsonb_build_array(target, n) order by n desc), '[]'::jsonb) from (
      select target, count(*) as n from w where kind = 'outbound' group by 1 order by 2 desc limit 20) t),
  'errors', (select coalesce(jsonb_agg(jsonb_build_array(target, n, sessions, last, page, src, browsers) order by n desc), '[]'::jsonb) from (
      select target, count(*) as n, count(distinct sid) as sessions, max(ts) as last,
             mode() within group (order by pp) as page,
             mode() within group (order by props->>'src') as src,
             (select string_agg(b, ', ') from (select distinct props->>'br' as b from w w2 where w2.kind = 'error' and w2.target = w.target limit 4) bb) as browsers
        from w where kind = 'error' group by target order by 2 desc limit 40) t),
  'api', (select coalesce(jsonb_agg(jsonb_build_array(target, st, n, avgms, p90ms) order by n desc), '[]'::jsonb) from (
      select target, coalesce(props->>'st', '?') as st, count(*) as n,
             round(avg(web_num(props->>'ms')), 0) as avgms,
             round((percentile_cont(0.9) within group (order by web_num(props->>'ms')))::numeric, 0) as p90ms
        from w where kind = 'api' group by 1, 2 order by 3 desc limit 40) t),
  'searches', (select coalesce(jsonb_agg(jsonb_build_array(q, n, visitors, zero, src) order by n desc), '[]'::jsonb) from (
      select lower(target) as q, count(*) as n, count(distinct vid) as visitors,
             count(*) filter (where (props->>'res') = '0') as zero,
             mode() within group (order by props->>'in') as src
        from w where kind = 'search' and coalesce(target, '') <> '' group by 1 order by 2 desc limit 60) t),
  'zeroSearches', (select coalesce(jsonb_agg(jsonb_build_array(q, n) order by n desc), '[]'::jsonb) from (
      select lower(target) as q, count(*) as n from w
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
        from w where kind = 'form_abandon' group by 1, 2 order by 3 desc limit 25) t),
  'fieldTimes', (select coalesce(jsonb_agg(jsonb_build_array(target, field, n, avgsec, emptyPct) order by n desc), '[]'::jsonb) from (
      select target, props->>'f' as field, count(*) as n,
             round(avg(web_num(props->>'ms')) / 1000, 1) as avgsec,
             round(100.0 * count(*) filter (where (props->>'filled') = '0') / greatest(1, count(*)), 0) as emptyPct
        from w where kind = 'field' group by 1, 2 order by 3 desc limit 40) t),
  'formErrors', (select coalesce(jsonb_agg(jsonb_build_array(target, msg, n) order by n desc), '[]'::jsonb) from (
      select target, props->>'msg' as msg, count(*) as n
        from w where kind = 'form_error' group by 1, 2 order by 3 desc limit 30) t),
  'toasts', (select coalesce(jsonb_agg(jsonb_build_array(k, target, n) order by n desc), '[]'::jsonb) from (
      select props->>'k' as k, target, count(*) as n from w where kind = 'toast' group by 1, 2 order by 3 desc limit 30) t),
  'perf', (select coalesce(jsonb_agg(jsonb_build_array(pp, n, ttfb, fcp, lcp, cls, inp) order by n desc), '[]'::jsonb) from (
      select pp, count(*) as n,
             round((percentile_cont(0.75) within group (order by web_num(props->>'ttfb')))::numeric, 0) as ttfb,
             round((percentile_cont(0.75) within group (order by web_num(props->>'fcp')))::numeric, 0) as fcp,
             round((percentile_cont(0.75) within group (order by web_num(props->>'lcp')))::numeric, 0) as lcp,
             round((percentile_cont(0.75) within group (order by web_num(props->>'cls')))::numeric, 3) as cls,
             round((percentile_cont(0.75) within group (order by web_num(props->>'inp')))::numeric, 0) as inp
        from w where kind = 'perf' group by pp order by 2 desc limit 20) t),
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

-- One student's full trail: their events (and their browser's events from
-- before they signed up), newest first.
create or replace function public.admin_user_journey(p_uid uuid, p_limit integer default 400)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'visitors', coalesce((select jsonb_agg(jsonb_build_object('vid', vid, 'firstSeen', first_seen, 'firstTouch', first_touch, 'linkedAt', linked_at) order by first_seen)
                            from web_visitors where uid = p_uid), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_array(ts, kind, path, target, props, sid) order by ts desc) from (
        select ts, kind, path, target, props, sid from web_events
         where uid = p_uid or vid in (select vid from web_visitors where uid = p_uid)
         order by ts desc limit greatest(1, least(coalesce(p_limit, 400), 2000))) t), '[]'::jsonb));
$$;

-- Click positions for one page group: [x as 0-1000 of the window width, y in
-- page pixels, page height, device].
create or replace function public.admin_click_map(p_path text, p_days integer default 7, p_dev text default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_array(x, y, h, dev, target)), '[]'::jsonb) from (
    select round(1000 * web_num(props->>'x') / greatest(1, web_num(props->>'vw'))) as x,
           web_num(props->>'py')::int as y, web_num(props->>'ph')::int as h, props->>'dev' as dev, target
      from web_events
     where kind = 'click' and ts > now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90)))
       and web_path_group(path) = p_path
       and props ? 'x' and props ? 'vw' and props ? 'py'
       and (p_dev is null or props->>'dev' = p_dev)
     order by ts desc limit 8000) t;
$$;

revoke all on function public.ingest_web_events(jsonb, uuid, text) from public, anon, authenticated;
revoke all on function public.roll_up_web_events(integer) from public, anon, authenticated;
revoke all on function public.admin_behaviour_stats(integer) from public, anon, authenticated;
revoke all on function public.admin_user_journey(uuid, integer) from public, anon, authenticated;
revoke all on function public.admin_click_map(text, integer, text) from public, anon, authenticated;
grant execute on function public.ingest_web_events(jsonb, uuid, text) to service_role;
grant execute on function public.roll_up_web_events(integer) to service_role;
grant execute on function public.admin_behaviour_stats(integer) to service_role;
grant execute on function public.admin_user_journey(uuid, integer) to service_role;
grant execute on function public.admin_click_map(text, integer, text) to service_role;
revoke all on table public.web_events, public.web_visitors, public.web_event_daily from anon, authenticated;

select cron.schedule('web-events-rollup', '25 20 * * *', $$select public.roll_up_web_events(2)$$);
