-- Visit → signup, for everyone, including the people who gave up.
--
-- Before this, a browser (vid) was tied to an account only once that account
-- sent events while signed in. Someone who filled the form but never typed the
-- emailed code never had a session, so 336 of 348 unlinked accounts in the week
-- to 25 Oct were exactly the drop-offs the funnel is meant to show.
--
-- Now:
--   • signUp sends the browser's vid in user metadata; a trigger on
--     auth.users links it the moment the account row exists (confirmed or not).
--   • every (vid, uid) pair the event endpoint sees is kept, so one browser
--     used for two accounts keeps both (web_visitors.uid holds only the first).
--   • older unconfirmed accounts are matched to the browser that submitted the
--     signup form in the minute before the account was created (only when
--     exactly one browser fits).
--   • admin_signup_funnel(days) and admin_visitor_journey(vid) read it all.

create table if not exists public.web_visitor_accounts (
  vid       text not null,
  uid       uuid not null,
  how       text not null,          -- signup | session | time_match
  linked_at timestamptz not null default now(),
  primary key (vid, uid)
);
create index if not exists web_visitor_accounts_uid_idx on public.web_visitor_accounts (uid);
alter table public.web_visitor_accounts enable row level security;

-- 1. At account creation. Never lets a tracking problem block a signup.
create or replace function public.link_visitor_on_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v text := new.raw_user_meta_data->>'vid';
begin
  if v is not null and v ~ '^[A-Za-z0-9_-]{8,40}$' then
    begin
      insert into web_visitor_accounts (vid, uid, how) values (v, new.id, 'signup')
      on conflict (vid, uid) do nothing;
      update web_visitors set uid = new.id, linked_at = now() where vid = v and uid is null;
    exception when others then null;
    end;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_link_visitor on auth.users;
create trigger on_auth_user_link_visitor after insert on auth.users
  for each row execute function public.link_visitor_on_signup();

-- 2. Every signed-in batch. Statement level: one insert per batch, not per row.
create or replace function public.web_events_link_accounts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into web_visitor_accounts (vid, uid, how)
  select distinct vid, uid, 'session' from new_rows where uid is not null
  on conflict (vid, uid) do nothing;
  return null;
exception when others then return null;
end $$;

drop trigger if exists web_events_link_accounts on public.web_events;
create trigger web_events_link_accounts after insert on public.web_events
  referencing new table as new_rows
  for each statement execute function public.web_events_link_accounts();

-- 3. Backfill: links already known.
insert into web_visitor_accounts (vid, uid, how, linked_at)
select vid, uid, 'session', coalesce(linked_at, first_seen) from web_visitors where uid is not null
on conflict (vid, uid) do nothing;

insert into web_visitor_accounts (vid, uid, how)
select distinct vid, uid, 'session' from web_events where uid is not null
on conflict (vid, uid) do nothing;

-- 4. Backfill: accounts with no browser yet, matched by the signup-form submit
--    in the 60 s before the account row was created. Only unique matches.
with u as (
  select id, created_at from auth.users
   where created_at > '2026-10-17' and not exists (select 1 from web_visitor_accounts a where a.uid = auth.users.id)),
s as (
  select vid, ts from web_events
   where kind = 'form_submit' and target = 'reg-form' and uid is null and ts > '2026-10-17'),
c as (
  select u.id, s.vid, count(*) over (partition by u.id) n_for_user
    from u join s on s.ts between u.created_at - interval '60 seconds' and u.created_at + interval '5 seconds'
   group by u.id, s.vid),
c2 as (select id, vid, count(*) over (partition by vid) n_for_vid from c where n_for_user = 1)
insert into web_visitor_accounts (vid, uid, how)
select vid, id, 'time_match' from c2 where n_for_vid = 1
on conflict (vid, uid) do nothing;

update web_visitors v set uid = a.uid, linked_at = now()
  from web_visitor_accounts a
 where a.vid = v.vid and v.uid is null and a.how = 'time_match';

-- 5. The funnel. Cohort = browsers first seen in the last p_days days.
create or replace function public.admin_signup_funnel(p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- Run as dynamic SQL with the day count written in: as a plain SQL function
-- the planner used a generic plan that took 14 s for 7 days; this takes ~1.6 s.
declare d integer := greatest(1, least(coalesce(p_days, 7), 60)); out jsonb;
begin
  execute format($q$
with prm as (select now() - make_interval(days => %1$s) t0),
-- Browsers already tied to an account made before they were first seen are
-- returning students on a new device, not new visitors: left out.
v as (
  select w.vid, w.first_seen, w.first_touch from web_visitors w, prm
   where w.first_seen >= prm.t0
     and not exists (select 1 from web_visitor_accounts a join auth.users u on u.id = a.uid
                      where a.vid = w.vid and u.created_at < w.first_seen - interval '1 hour')),
-- Only what the funnel reads: pages, and the signup/code forms, straight from
-- web_events_funnel_idx (no clicks, no props: reading props for every row
-- took 11 s of a 13 s run). props are read only for field and error rows.
ev as (
  select e.vid, e.ts, e.kind, e.path, e.target, e.sid
    from web_events e join v using (vid), prm
   where e.ts >= prm.t0
     and (e.kind in ('session_start','page') or (e.kind in ('form_start','field','form_submit','form_error') and e.target in ('reg-form','otp-form')))),
det as (
  select e.vid,
    (array_agg(e.target||' · '||(e.props->>'f') order by e.ts desc) filter (where e.kind = 'field'))[1] last_field,
    (array_agg(left(e.props->>'msg', 140) order by e.ts desc) filter (where e.kind = 'form_error'))[1] last_error
    from web_events e join v using (vid), prm
   where e.ts >= prm.t0 and e.kind in ('field','form_error') and e.target in ('reg-form','otp-form')
   group by e.vid),
acc as (
  select a.vid, bool_or(true) has_acct,
         bool_or(u.email_confirmed_at is not null or coalesce(u.raw_app_meta_data->>'provider','') <> 'email') confirmed,
         min(u.created_at) acct_at, min(u.email_confirmed_at) confirmed_at,
         (array_agg(a.uid order by u.created_at))[1] uid,
         bool_or(coalesce(u.raw_app_meta_data->>'provider','') = 'google') google
    from web_visitor_accounts a join v using (vid) join auth.users u on u.id = a.uid
   group by a.vid),
per as (
  select ev.vid,
    count(*) filter (where ev.kind = 'page') pages,
    count(distinct ev.sid) sessions,
    max(ev.ts) last_ts, min(ev.ts) first_ts,
    bool_or((ev.kind = 'page' and ev.path in ('/register','/login')) or ev.target in ('reg-form','otp-form')) saw,
    bool_or(ev.kind = 'form_start' and ev.target = 'reg-form') started,
    bool_or(ev.kind = 'form_submit' and ev.target = 'reg-form') submitted,
    bool_or(ev.kind = 'form_start' and ev.target = 'otp-form') otp,
    min(ev.ts) filter (where (ev.kind = 'page' and ev.path in ('/register','/login')) or ev.target in ('reg-form','otp-form')) saw_at,
    (array_agg(ev.path order by ev.ts desc) filter (where ev.kind = 'page'))[1] last_page,
    count(*) filter (where ev.kind = 'form_error') n_errors
  from ev
  group by ev.vid),
j as (
  select v.first_seen, v.first_touch, p.*, d.last_field, d.last_error, coalesce(a.has_acct, false) has_acct, coalesce(a.confirmed, false) confirmed, a.acct_at, a.confirmed_at, a.uid, coalesce(a.google, false) google,
    case when coalesce(a.confirmed, false) then 6
         when p.otp then 5
         when coalesce(a.has_acct, false) then 4
         when p.submitted then 3
         when p.started then 2
         when p.saw then 1 else 0 end step
  from v join per p using (vid) left join acc a using (vid) left join det d using (vid))
select jsonb_build_object(
  'days', %1$s,
  'generatedAt', now(),
  'steps', (select jsonb_agg(jsonb_build_object('step', s, 'n', (select count(*) from j where j.step >= s)) order by s) from generate_series(0, 6) s),
  'google', (select count(*) from j where google),
  'dropFields', (select coalesce(jsonb_agg(jsonb_build_array(step, last_field, n) order by step, n desc), '[]') from (
      select step, last_field, count(*) n, row_number() over (partition by step order by count(*) desc) rk from j
       where step between 1 and 5 and last_field is not null group by 1,2) z where rk <= 6),
  'dropErrors', (select coalesce(jsonb_agg(jsonb_build_array(step, last_error, n) order by step, n desc), '[]') from (
      select step, last_error, count(*) n, row_number() over (partition by step order by count(*) desc) rk from j
       where step between 1 and 5 and last_error is not null group by 1,2) z where rk <= 6),
  'dropPages', (select coalesce(jsonb_agg(jsonb_build_array(step, last_page, n) order by step, n desc), '[]') from (
      select step, web_path_group(last_page) last_page, count(*) n, row_number() over (partition by step order by count(*) desc) rk from j
       where step < 6 and last_page is not null group by 1,2) z where rk <= 6),
  'people', (select coalesce(jsonb_agg(x order by (x->>'lastTs') desc), '[]') from (
      select jsonb_build_object('vid', vid, 'first', first_seen, 'lastTs', last_ts, 'step', step,
        'src', first_touch->>'src', 'landing', first_touch->>'landing', 'dev', first_touch->>'dev', 'os', first_touch->>'os', 'cc', first_touch->>'cc',
        'pages', pages, 'sessions', sessions, 'mins', round(extract(epoch from (last_ts - first_ts)) / 60.0, 1),
        'lastPage', last_page, 'lastField', last_field, 'lastError', last_error, 'errors', n_errors,
        'sawAt', saw_at, 'acctAt', acct_at, 'confirmedAt', confirmed_at, 'uid', uid, 'google', google) x
      from j where step >= 1 order by last_ts desc nulls last limit 300) q)
)
$q$, d) into out;
  return out;
end $fn$;

-- 6. One browser's trail (signed in or not), same shape as admin_user_journey.
create or replace function public.admin_visitor_journey(p_vid text, p_limit integer default 600)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'visitors', coalesce((select jsonb_agg(jsonb_build_object('vid', vid, 'firstSeen', first_seen, 'firstTouch', first_touch, 'linkedAt', linked_at))
                            from web_visitors where vid = p_vid), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('uid', a.uid, 'how', a.how, 'createdAt', u.created_at, 'confirmedAt', u.email_confirmed_at,
                              'provider', u.raw_app_meta_data->>'provider', 'username', u.raw_user_meta_data->>'username') order by u.created_at)
                            from web_visitor_accounts a join auth.users u on u.id = a.uid where a.vid = p_vid), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_array(ts, kind, path, target, props, sid) order by ts desc) from (
        select ts, kind, path, target, props, sid from web_events where vid = p_vid
         order by ts desc limit greatest(1, least(coalesce(p_limit, 600), 2000))) t), '[]'::jsonb));
$$;

-- Accounts on this browser also count for the user journey (two accounts, one browser).
create or replace function public.admin_user_journey(p_uid uuid, p_limit integer default 400)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with vids as (
    select vid from web_visitors where uid = p_uid
    union select vid from web_visitor_accounts where uid = p_uid)
  select jsonb_build_object(
    'visitors', coalesce((select jsonb_agg(jsonb_build_object('vid', vid, 'firstSeen', first_seen, 'firstTouch', first_touch, 'linkedAt', linked_at) order by first_seen)
                            from web_visitors where vid in (select vid from vids)), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_array(ts, kind, path, target, props, sid) order by ts desc) from (
        select ts, kind, path, target, props, sid from web_events
         where uid = p_uid or vid in (select vid from vids)
         order by ts desc limit greatest(1, least(coalesce(p_limit, 400), 2000))) t), '[]'::jsonb));
$$;

revoke all on function public.link_visitor_on_signup() from public, anon, authenticated;
revoke all on function public.web_events_link_accounts() from public, anon, authenticated;
revoke all on function public.admin_signup_funnel(integer) from public, anon, authenticated;
revoke all on function public.admin_visitor_journey(text, integer) from public, anon, authenticated;
revoke all on function public.admin_user_journey(uuid, integer) from public, anon, authenticated;

-- 7. Cached like the Behaviour tab: a 7-day pass takes 2–15 s on this
--    instance (it shares the CPU with the behaviour-cache job), too slow to
--    run on every admin page open. One range per run, the most overdue.
create table if not exists public.admin_funnel_cache (
  days        integer primary key,
  data        jsonb not null,
  computed_at timestamptz not null,
  ms          integer
);
alter table public.admin_funnel_cache enable row level security;

create or replace function public.refresh_admin_funnel(p_force boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare d integer; t0 timestamptz; j jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('refresh_admin_funnel')) then return -1; end if;
  select r.d into d
    from unnest(array[1, 7, 30]) as r(d)
    left join admin_funnel_cache c on c.days = r.d
   where p_force or c.days is null
      or c.computed_at < clock_timestamp() - case r.d when 1 then interval '4 minutes'
                                                    when 7 then interval '9 minutes'
                                                    else interval '55 minutes' end
   order by c.computed_at nulls first, r.d
   limit 1;
  if d is null then return 0; end if;
  t0 := clock_timestamp();
  j := admin_signup_funnel(d);
  insert into admin_funnel_cache (days, data, computed_at, ms)
  values (d, j, t0, round(extract(epoch from clock_timestamp() - t0) * 1000))
  on conflict (days) do update set data = excluded.data, computed_at = excluded.computed_at, ms = excluded.ms;
  return d;
end $$;

create or replace function public.admin_funnel_cached(p_days integer default 7)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select data || jsonb_build_object('computedAt', computed_at, 'ms', ms) from admin_funnel_cache where days = p_days),
    jsonb_build_object('pending', true, 'days', p_days));
$$;

revoke all on function public.refresh_admin_funnel(boolean) from public, anon, authenticated;
revoke all on function public.admin_funnel_cached(integer) from public, anon, authenticated;

select cron.schedule('signup-funnel-cache', '*/3 * * * *',
  $c$set statement_timeout = '5min'; select public.refresh_admin_funnel();$c$);
