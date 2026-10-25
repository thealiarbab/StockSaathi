-- Applied 25 Oct 2026 after the Signups tab went HTTP 502 (13:45 IST): the
-- behaviour-cache 30/90-day pass had the CPU for 5+ minutes and
-- admin_signup_stats() (3 s normally) took 57 s, past the API's limit.

-- 1. Signups stats from a 5-minute cache (api/ai.js opAdminSignupStats reads it,
--    falls back to the live function only if the cache is empty).
create table if not exists public.admin_stats_cache (
  name        text primary key,
  data        jsonb not null,
  computed_at timestamptz not null,
  ms          integer
);
alter table public.admin_stats_cache enable row level security;

create or replace function public.refresh_admin_signup_stats()
returns integer language plpgsql security definer set search_path = public as $$
declare t0 timestamptz; j jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('refresh_admin_signup_stats')) then return -1; end if;
  t0 := clock_timestamp();
  j := admin_signup_stats();
  insert into admin_stats_cache (name, data, computed_at, ms)
  values ('signup_stats', j, t0, round(extract(epoch from clock_timestamp() - t0) * 1000))
  on conflict (name) do update set data = excluded.data, computed_at = excluded.computed_at, ms = excluded.ms;
  return 1;
end $$;

create or replace function public.admin_signup_stats_cached()
returns jsonb language sql stable security definer set search_path = public as $$
  select data || jsonb_build_object('computedAt', computed_at, 'ms', ms) from admin_stats_cache where name = 'signup_stats';
$$;
revoke all on function public.refresh_admin_signup_stats() from public, anon, authenticated;
revoke all on function public.admin_signup_stats_cached() from public, anon, authenticated;
select cron.schedule('signup-stats-cache', '*/5 * * * *',
  $c$set statement_timeout = '5min'; select public.refresh_admin_signup_stats();$c$);

-- 2. Behaviour cache: 7-day pass (~3.5 min) every 2 h instead of 30 min; the
--    30/90-day passes only 2-6 am IST (unless the range has never been built).
create or replace function public.refresh_admin_behaviour(p_force boolean default false)
 returns integer language plpgsql security definer set search_path to 'public'
as $function$
declare d integer; t0 timestamptz; j jsonb;
  night boolean := extract(hour from (now() at time zone 'Asia/Kolkata')) between 2 and 5;
begin
  if not pg_try_advisory_xact_lock(hashtext('refresh_admin_behaviour')) then return -1; end if;
  select r.d into d
    from unnest(array[1, 7, 30, 90]) as r(d)
    left join admin_behaviour_cache c on c.days = r.d
   where (p_force or c.days is null
      or c.computed_at < clock_timestamp() - case r.d when 1 then interval '9 minutes'
                                                    when 7 then interval '119 minutes'
                                                    else interval '23 hours' end)
     and (r.d <= 7 or night or c.days is null or p_force)
   order by c.computed_at nulls first, r.d
   limit 1;
  if d is null then return 0; end if;
  t0 := clock_timestamp();
  j := admin_behaviour_stats(d);
  insert into admin_behaviour_cache (days, data, computed_at, ms)
  values (d, j, t0, round(extract(epoch from clock_timestamp() - t0) * 1000))
  on conflict (days) do update set data = excluded.data, computed_at = excluded.computed_at, ms = excluded.ms;
  return d;
end $function$;

-- 3. Funnel cache lighter: every 15 min, 1 d / 7 d / 30 d refreshed after
--    14 min / 29 min / 6 h, skipped while a behaviour pass runs.
select cron.alter_job((select jobid from cron.job where jobname = 'signup-funnel-cache'), schedule => '7,22,37,52 * * * *');
create or replace function public.refresh_admin_funnel(p_force boolean default false)
returns integer language plpgsql security definer set search_path = public as $$
declare d integer; t0 timestamptz; j jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('refresh_admin_funnel')) then return -1; end if;
  if exists (select 1 from pg_stat_activity where state = 'active' and query like '%refresh_admin_behaviour%' and pid <> pg_backend_pid()) then return -2; end if;
  select r.d into d
    from unnest(array[1, 7, 30]) as r(d)
    left join admin_funnel_cache c on c.days = r.d
   where p_force or c.days is null
      or c.computed_at < clock_timestamp() - case r.d when 1 then interval '14 minutes'
                                                    when 7 then interval '29 minutes'
                                                    else interval '6 hours' end
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
revoke all on function public.refresh_admin_funnel(boolean) from public, anon, authenticated;
