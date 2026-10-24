-- Uptime alerts. pg_cron runs ops_health_check() every 5 minutes; a failing
-- check writes a notification to the owner accounts (bell + web push via the
-- existing notifications pipeline), at most once per 2 hours per check.
--
-- Checks (market checks only Mon-Fri 09:20-15:30 IST; NSE holidays are not
-- known here, so a holiday can raise one stale-quote alert):
--   quotes_stale     students opened stock pages in the last 20 min but no
--                    Yahoo quote was refreshed in that time
--   matcher_stalled  no successful order-matcher cron run in 10 min
--   matcher_http     >= 3 failed pg_net responses (non-2xx / timeout) in 15 min
--   chat_failing     >= 30% of /api/chat attempts failed in 15 min (>= 6 attempts)
--   chat_fallback    >= 50% of coach answers came from Gemini in 30 min (>= 6)

create table if not exists public.ops_alerts (
  check_name text primary key,
  last_fired timestamptz,
  last_ok timestamptz,
  last_detail text,
  fired_count int not null default 0
);
alter table public.ops_alerts enable row level security;
revoke all on public.ops_alerts from public, anon, authenticated;

create or replace function public.ops_health_check()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ist timestamp := now() at time zone 'Asia/Kolkata';
  market boolean := extract(isodow from ist) between 1 and 5
                    and ist::time between time '09:20' and time '15:30';
  results jsonb := '[]'::jsonb;
  checks jsonb := '[]'::jsonb;
  c record;
  n_views int; n_quotes int; n_fail int; n_total int; n_gem int; last_run timestamptz;
begin
  if market then
    select count(*) into n_views from public.user_events
      where kind = 'stock_view' and occurred_at > now() - interval '20 minutes';
    select count(*) into n_quotes from public.quote_cache
      where source = 'yahoo' and updated_at > now() - interval '20 minutes';
    checks := checks || jsonb_build_object('name', 'quotes_stale', 'failing', n_views >= 5 and n_quotes = 0, 'detail',
      format('%s stock views, %s Yahoo quotes refreshed in 20 min', n_views, n_quotes));

    select max(d.start_time) into last_run from cron.job_run_details d join cron.job j using (jobid)
      where j.jobname = 'order-matcher' and d.status = 'succeeded';
    checks := checks || jsonb_build_object('name', 'matcher_stalled', 'failing', last_run is null or last_run < now() - interval '10 minutes', 'detail',
      format('last successful order-matcher run: %s', coalesce(to_char(last_run at time zone 'Asia/Kolkata', 'DD Mon HH24:MI IST'), 'never')));
  end if;

  select count(*) into n_fail from net._http_response
    where created > now() - interval '15 minutes'
      and (timed_out or error_msg is not null or status_code is null or status_code >= 400);
  checks := checks || jsonb_build_object('name', 'matcher_http', 'failing', n_fail >= 3, 'detail',
    format('%s failed pg_net calls (order matcher / push / snapshot) in 15 min', n_fail));

  select count(*) filter (where not ok), count(*) into n_fail, n_total from public.llm_usage
    where route = 'chat' and ts > now() - interval '15 minutes';
  checks := checks || jsonb_build_object('name', 'chat_failing', 'failing', n_total >= 6 and n_fail * 10 >= n_total * 3, 'detail',
    format('%s of %s coach attempts failed in 15 min', n_fail, n_total));

  select count(*) filter (where ok and upstream like 'gemini%'), count(*) filter (where ok)
    into n_gem, n_total from public.llm_usage where route = 'chat' and ts > now() - interval '30 minutes';
  checks := checks || jsonb_build_object('name', 'chat_fallback', 'failing', n_total >= 6 and n_gem * 2 >= n_total, 'detail',
    format('%s of %s coach answers came from the Gemini fallback in 30 min (Haiku failing?)', n_gem, n_total));

  for c in select x->>'name' as name, (x->>'failing')::boolean as failing, x->>'detail' as detail from jsonb_array_elements(checks) x loop
    insert into public.ops_alerts (check_name) values (c.name) on conflict do nothing;
    if c.failing then
      if coalesce((select last_fired from public.ops_alerts where check_name = c.name), '-infinity') < now() - interval '2 hours' then
        insert into public.notifications (user_id, kind, category, title, body, url)
        select u.id, 'ops_alert', 'account', 'StockSaathi alert: ' || c.name, c.detail, '/a'
        from (select user_id as id from public.admin_users
              union select '63aee5be-4eaa-409d-9c1e-f60c4daa5823'::uuid
              union select '73c89104-24ab-47c0-9c71-5fe7c82323dc'::uuid) u
        where exists (select 1 from auth.users au where au.id = u.id);
        update public.ops_alerts set last_fired = now(), last_detail = c.detail, fired_count = fired_count + 1
          where check_name = c.name;
      end if;
    else
      update public.ops_alerts set last_ok = now() where check_name = c.name;
    end if;
    results := results || jsonb_build_object('check', c.name, 'failing', c.failing, 'detail', c.detail);
  end loop;
  return jsonb_build_object('at', now(), 'market_open', market, 'checks', results);
end;
$$;
revoke all on function public.ops_health_check() from public, anon, authenticated;
grant execute on function public.ops_health_check() to service_role;

select cron.schedule('ops-health', '*/5 * * * *', $cron$select public.ops_health_check()$cron$);
