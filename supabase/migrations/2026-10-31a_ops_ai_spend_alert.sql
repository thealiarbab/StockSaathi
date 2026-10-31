-- AI spend watcher (31 Oct 2026).
--
-- /api/chat and /api/ai pay for every token. If someone scripts them (or a
-- client bug loops), the bill grows by the hour and nothing told us. Two new
-- checks in ops_health_check() (pg_cron ops-health, every 5 min), alerting the
-- owner accounts by bell + push like the other checks, 2 h cooldown:
--
--   ai_spend_hour  output+reasoning tokens in the last 60 min > 2.5M.
--                  Worst real hour in Oct: 1.37M (26 Oct, ~1,500 calls).
--   ai_spend_day   output+reasoning tokens since IST midnight > 15M.
--                  Worst real day in Oct: 7.0M (26 Oct, ~Rs 370).
--
-- Thresholds are ~2x the worst real traffic so a normal busy school day stays
-- quiet. llm_usage has no user or IP column (by design), so this says THAT
-- spend spiked, not who; the Vercel logs say who.

create or replace function public.ops_health_check()
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  ist timestamp := now() at time zone 'Asia/Kolkata';
  market boolean := extract(isodow from ist) between 1 and 5
                    and ist::time between time '09:20' and time '15:30';
  results jsonb := '[]'::jsonb;
  checks jsonb := '[]'::jsonb;
  c record;
  n_views int; n_quotes int; n_fail int; n_total int; n_gem int; last_run timestamptz;
  tok_hour bigint; tok_day bigint; calls_hour int;
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

  select coalesce(sum(coalesce(output_tokens,0) + coalesce(reasoning_tokens,0)), 0), count(*)
    into tok_hour, calls_hour from public.llm_usage where ts > now() - interval '60 minutes';
  checks := checks || jsonb_build_object('name', 'ai_spend_hour', 'failing', tok_hour > 2500000, 'detail',
    format('%s output tokens from %s AI calls in the last hour (worst real hour: 1.37M). Check Vercel logs for /api/chat + /api/ai by IP.',
      to_char(tok_hour, 'FM999,999,999'), calls_hour));

  select coalesce(sum(coalesce(output_tokens,0) + coalesce(reasoning_tokens,0)), 0)
    into tok_day from public.llm_usage where ts >= (date_trunc('day', ist) at time zone 'Asia/Kolkata');
  checks := checks || jsonb_build_object('name', 'ai_spend_day', 'failing', tok_day > 15000000, 'detail',
    format('%s output tokens on AI since midnight IST (worst real day: 7.0M, about Rs 370). See /a > AI cost.',
      to_char(tok_day, 'FM999,999,999')));

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
$function$;

revoke all on function public.ops_health_check() from public, anon, authenticated;
