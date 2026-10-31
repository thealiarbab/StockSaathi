-- Attack response + sign-up watch + cleanup (31 Oct 2026).
--  * ai_guard_state: one row; lockdown_until set by ops_ai_watch() on an
--    "attack" verdict (30 min, extended while it lasts). api/_guard.js reads
--    it every 30 s: /api/chat answers 503 "busy", /api/ai serves saved answers
--    and starts no new model call. Manual end: update ... set lockdown_until = now().
--  * ops_health_check: signup_spike (alert only, never blocks a sign-up).
--  * Leftover test functions zz_live_test, zz_live_test2, zz_t3 were callable
--    by anyone with the public key; access revoked.

create table if not exists public.ai_guard_state (
  id int primary key check (id = 1),
  lockdown_until timestamptz,
  reason text,
  updated_at timestamptz not null default now()
);
insert into public.ai_guard_state (id) values (1) on conflict do nothing;
alter table public.ai_guard_state enable row level security;
revoke all on public.ai_guard_state from public, anon, authenticated;

create or replace function public.ops_ai_watch()
 returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  now_ist timestamp := now() at time zone 'Asia/Kolkata';
  today date := (now() at time zone 'Asia/Kolkata')::date;
  mid timestamptz := ((now() at time zone 'Asia/Kolkata')::date)::timestamp at time zone 'Asia/Kolkata';
  p15 bigint; p60 bigint; pday bigint; pip bigint; pdev bigint;
  key_days int; n_days int; base_top5 numeric; base_nc numeric; typ_h numeric;
  c15 bigint; c60 bigint; cday bigint; c60h bigint; top5 bigint; nocookie bigint; calls60 int;
  v numeric; odd_ratio numeric; sv numeric; sc numeric := 0; sn numeric := 0; so numeric;
  score int; verdict text; k record; blocks jsonb := '[]'; detail jsonb; msg text;
begin
  if not exists (select 1 from public.ai_watch_baseline where day = today - 1) then
    perform public.ai_watch_baseline_refresh(28);
  end if;

  select greatest(coalesce(max(tok_15m_max), 0), 200000),
         greatest(coalesce(max(tok_60m_max), 0), 700000),
         greatest(coalesce(max(tok_day), 0), 4000000),
         greatest(coalesce(max(key_ip_60m_max), 0), 300000),
         greatest(coalesce(max(key_dev_60m_max), 0), 100000),
         count(*) filter (where key_dev_60m_max is not null),
         count(*),
         coalesce(avg(top5_ip_share), 0.35),
         coalesce(avg(nocookie_share), 0.25),
         coalesce(avg(hour_tok[extract(hour from now_ist)::int + 1]), 0)
    into p15, p60, pday, pip, pdev, key_days, n_days, base_top5, base_nc, typ_h
    from public.ai_watch_baseline where day >= today - 28 and day < today and not skip_peak;

  select coalesce(sum(o) filter (where ts > now() - interval '15 minutes'), 0),
         coalesce(sum(o) filter (where ts > now() - interval '60 minutes'), 0),
         coalesce(sum(o) filter (where ts >= mid), 0),
         coalesce(sum(o) filter (where ts > now() - interval '60 minutes' and ip_hash is not null), 0),
         coalesce(sum(o) filter (where ts > now() - interval '60 minutes' and dev_hash is null), 0),
         count(*) filter (where ts > now() - interval '60 minutes')
    into c15, c60, cday, c60h, nocookie, calls60
    from (select ts, coalesce(output_tokens, 0) + coalesce(reasoning_tokens, 0) as o, ip_hash, dev_hash
          from public.llm_usage where ts >= least(mid, now() - interval '60 minutes')) x;

  select coalesce(sum(s), 0) into top5 from (
    select sum(coalesce(output_tokens, 0) + coalesce(reasoning_tokens, 0)) as s from public.llm_usage
    where ts > now() - interval '60 minutes' and ip_hash is not null group by ip_hash order by 1 desc limit 5) t;

  v  := greatest(c15::numeric / p15, c60::numeric / p60, cday::numeric / pday);
  sv := 60 * least(v / 2, 1.5);
  if key_days >= 3 and c60 >= 100000 then
    if c60h > 0 then
      sc := 20 * greatest(0, least(1, (top5::numeric / c60h - base_top5) / greatest(1 - base_top5, 0.05)));
    end if;
    sn := 10 * greatest(0, least(1, (nocookie::numeric / c60 - base_nc) / greatest(1 - base_nc, 0.05)));
  end if;
  odd_ratio := c60 / greatest(typ_h, 50000);
  so := 10 * greatest(0, least(1, ln(greatest(odd_ratio, 1)) / ln(2) / 3));
  score := least(100, round(sv + sc + sn + so))::int;
  verdict := case when score >= 60 and (sc >= 10 or sn >= 5) then 'attack'
                  when score >= 60 then 'alert'
                  when score >= 40 then 'elevated'
                  else 'normal' end;

  -- Per-caller blocks.
  for k in
    select 'ip' as kind, ip_hash as h, sum(coalesce(output_tokens, 0) + coalesce(reasoning_tokens, 0)) as s, count(*) as n
      from public.llm_usage where ts > now() - interval '60 minutes' and ip_hash is not null
      group by ip_hash having sum(coalesce(output_tokens, 0) + coalesce(reasoning_tokens, 0)) >= 2 * pip
    union all
    select 'dev', dev_hash, sum(coalesce(output_tokens, 0) + coalesce(reasoning_tokens, 0)), count(*)
      from public.llm_usage where ts > now() - interval '60 minutes' and dev_hash is not null
      group by dev_hash having sum(coalesce(output_tokens, 0) + coalesce(reasoning_tokens, 0)) >= 2 * pdev
  loop
    insert into public.ai_blocks as b (key_hash, kind, until, shadow, reason)
    values (k.h, k.kind, now() + interval '1 hour', k.kind = 'ip' and key_days < 7,
            format('%s tokens / %s calls in 60 min (limit %s)', k.s, k.n, 2 * case when k.kind = 'ip' then pip else pdev end))
    on conflict (key_hash) do update set
      hits   = case when b.until < now() then b.hits + 1 else b.hits end,
      until  = greatest(b.until, now() + least(case when b.until < now() then b.hits + 1 else b.hits end, 24) * interval '1 hour'),
      shadow = excluded.shadow,
      reason = excluded.reason;
    blocks := blocks || jsonb_build_object('kind', k.kind, 'hash', left(k.h, 6), 'tokens', k.s, 'calls', k.n,
                                           'enforced', not (k.kind = 'ip' and key_days < 7));
  end loop;

  detail := jsonb_build_object(
    'score', score, 'verdict', verdict,
    'parts', jsonb_build_object('volume', round(sv), 'clustering', round(sc), 'no_cookie', round(sn), 'odd_hour', round(so)),
    'now', jsonb_build_object('t15', c15, 't60', c60, 'today', cday, 'calls60', calls60),
    'peak', jsonb_build_object('t15', p15, 't60', p60, 'day', pday, 'ip60', pip, 'dev60', pdev),
    'ratio', round(v, 2), 'baseline_days', n_days, 'per_caller_days', key_days, 'blocks', blocks);

  if verdict in ('alert', 'attack') then
    msg := format(
      E'Score %s/100 (%s). AI spend is %sx its 28-day peak.\n'
      'Last 15 min: %s tokens (peak %s). Last hour: %s tokens, %s calls (peak %s). Today: %s (peak day %s).\n'
      'Parts: volume %s, one-group clustering %s, no browser id %s, unusual hour %s.\n'
      'Callers blocked this minute: %s.\n'
      'Hard stop if needed: lower the Vertex AI quota in Google Cloud, or pause the project in Vercel.',
      score, verdict, round(v, 1),
      to_char(c15, 'FM999,999,999'), to_char(p15, 'FM999,999,999'),
      to_char(c60, 'FM999,999,999'), calls60, to_char(p60, 'FM999,999,999'),
      to_char(cday, 'FM999,999,999'), to_char(pday, 'FM999,999,999'),
      round(sv), round(sc), round(sn), round(so), jsonb_array_length(blocks));
    if verdict = 'attack' then
      -- AI lockdown: saved answers keep being served, no new paid model calls
      -- for 30 min (api/_guard.js). Extended while the attack lasts.
      insert into public.ai_guard_state (id, lockdown_until, reason) values (1, now() + interval '30 minutes', format('score %s', score))
        on conflict (id) do update set lockdown_until = greatest(public.ai_guard_state.lockdown_until, now() + interval '30 minutes'),
                                       reason = excluded.reason, updated_at = now();
      msg := msg || E'\nAI LOCKDOWN ON for 30 min: saved answers still served, no new paid AI calls. End it early: update ai_guard_state set lockdown_until = now();';
    end if;
    perform public._ops_notify(case when verdict = 'attack' then 'ai_attack' else 'ai_alert' end,
                               case when verdict = 'attack' then interval '30 minutes' else interval '2 hours' end,
                               'StockSaathi: AI spend ' || verdict, msg);
  end if;
  if jsonb_array_length(blocks) > 0 then
    perform public._ops_notify('ai_block', interval '1 hour', 'StockSaathi: AI caller blocked',
      format(E'%s caller(s) spent over 2x the worst real single-caller hour and were put on the blocklist:\n%s',
             jsonb_array_length(blocks), blocks::text));
  end if;

  if score >= 30 or jsonb_array_length(blocks) > 0 or extract(minute from now()) = 0 then
    insert into public.ai_watch_runs (ts, score, verdict, detail) values (now(), score, verdict, detail)
      on conflict (ts) do nothing;
  end if;
  return detail;
end $$;
revoke all on function public.ops_ai_watch() from public, anon, authenticated;

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
  n_su int; n_su_unconf int; su_peak int;
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
    format('%s failed pg_net calls (order matcher / push / snapshot / alert mail) in 15 min', n_fail));

  select count(*) filter (where not ok), count(*) into n_fail, n_total from public.llm_usage
    where route = 'chat' and ts > now() - interval '15 minutes';
  checks := checks || jsonb_build_object('name', 'chat_failing', 'failing', n_total >= 6 and n_fail * 10 >= n_total * 3, 'detail',
    format('%s of %s coach attempts failed in 15 min', n_fail, n_total));

  select count(*) filter (where ok and upstream like 'gemini%'), count(*) filter (where ok)
    into n_gem, n_total from public.llm_usage where route = 'chat' and ts > now() - interval '30 minutes';
  checks := checks || jsonb_build_object('name', 'chat_fallback', 'failing', n_total >= 6 and n_gem * 2 >= n_total, 'detail',
    format('%s of %s coach answers came from the Gemini fallback in 30 min (Haiku failing?)', n_gem, n_total));

  -- Sign-up spike: new accounts in 15 min vs 2x the worst real 15 min of
  -- the last 28 days (min 25). Alert only; nothing is blocked.
  select count(*), count(*) filter (where email_confirmed_at is null) into n_su, n_su_unconf
    from auth.users where created_at > now() - interval '15 minutes';
  select coalesce(max(cnt), 0) into su_peak from (
    select count(*) as cnt from auth.users
    where created_at > now() - interval '28 days' and created_at < now() - interval '1 hour'
    group by date_bin('15 minutes', created_at, timestamptz '2000-01-01')) s;
  checks := checks || jsonb_build_object('name', 'signup_spike', 'failing', n_su > greatest(2 * su_peak, 25), 'detail',
    format('%s new accounts in 15 min (%s unverified); the busiest real 15 min in 28 days had %s. Mass sign-up? Check /a Signups.',
      n_su, n_su_unconf, su_peak));

  for c in select x->>'name' as name, (x->>'failing')::boolean as failing, x->>'detail' as detail from jsonb_array_elements(checks) x loop
    insert into public.ops_alerts (check_name) values (c.name) on conflict do nothing;
    if c.failing then
      perform public._ops_notify(c.name, interval '2 hours', 'StockSaathi alert: ' || c.name, c.detail);
    else
      update public.ops_alerts set last_ok = now() where check_name = c.name;
    end if;
    results := results || jsonb_build_object('check', c.name, 'failing', c.failing, 'detail', c.detail);
  end loop;
  return jsonb_build_object('at', now(), 'market_open', market, 'checks', results);
end;
$function$;
revoke all on function public.ops_health_check() from public, anon, authenticated;

revoke all on function public.zz_live_test(integer) from public, anon, authenticated;
revoke all on function public.zz_live_test2(integer) from public, anon, authenticated;
revoke all on function public.zz_t3(integer) from public, anon, authenticated;
