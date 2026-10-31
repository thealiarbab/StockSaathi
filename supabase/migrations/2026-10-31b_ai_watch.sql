-- AI abuse watcher (31 Oct 2026). Replaces the fixed ai_spend_hour/day checks
-- of 2026-10-31a with thresholds computed from our own history, a combined
-- anomaly score, automatic per-caller blocks, and e-mail for every ops alert.
--
-- HOW THE SCORE WORKS (ops_ai_watch, pg_cron every minute)
--   Baselines (ai_watch_baseline, one row per IST day, last 28 days, attack
--   days left out): worst 15-min, worst hour, whole day, worst single IP and
--   single browser hour, typical top-5-IP share, typical no-cookie share,
--   tokens per hour of day. "Peak" = the worst of those 28 days, with floors
--   so a quiet month cannot make the line absurdly low.
--   Signals now (output + reasoning tokens):
--     V volume     max(now / peak) over 15 min, 60 min, today.   60 pts at 2x
--     C clustering top-5 IPs' share of the last hour above usual.  up to 20
--     N no cookie  share from callers without the browser id above usual. 10
--     O odd hour   last hour vs what this hour of day usually sees.     10
--   score = V + C + N + O (0-100). >= 60 alert: 2x peak alone is enough, or
--   a smaller rise that is also concentrated / cookieless / off-hours.
--   alert + (C >= 10 or N >= 5) = "attack": shorter re-alert, day kept out
--   of future baselines so an attack cannot raise its own threshold.
-- PER-CALLER BLOCKS
--   An IP or browser hash that spent >= 2x the worst real single-IP /
--   single-browser hour in the last 60 min goes on ai_blocks for 1 h (2 h, 3 h
--   ... on repeats, max 24 h). /api/chat and /api/ai refuse it with 429
--   (api/_guard.js). IP blocks stay in shadow (logged, not enforced) until 7
--   days of per-IP history exist: a whole school shares one IP and the real
--   ceiling is not known yet. Browser blocks are enforced from day one
--   (floor: 200k tokens in an hour from one browser, ~270 answers).
-- PRIVACY: ip_hash/dev_hash are day-keyed HMACs (api/_guard.js), cleared
--   from llm_usage after 48 h by ai_watch_daily().

alter table public.llm_usage add column if not exists ip_hash text;
alter table public.llm_usage add column if not exists dev_hash text;
create index if not exists llm_usage_ts_idx on public.llm_usage (ts);

create table if not exists public.ai_watch_baseline (
  day date primary key,
  tok_day bigint not null default 0,
  tok_15m_max bigint not null default 0,
  tok_60m_max bigint not null default 0,
  key_ip_60m_max bigint,
  key_dev_60m_max bigint,
  top5_ip_share numeric,
  nocookie_share numeric,
  hour_tok bigint[] not null default '{}',
  skip_peak boolean not null default false,
  computed_at timestamptz not null default now()
);
create table if not exists public.ai_blocks (
  key_hash text primary key,
  kind text not null check (kind in ('ip', 'dev')),
  first_at timestamptz not null default now(),
  until timestamptz not null,
  hits int not null default 1,
  shadow boolean not null default true,
  reason text
);
create table if not exists public.ai_watch_runs (
  ts timestamptz primary key default now(),
  score int not null,
  verdict text not null,
  detail jsonb not null default '{}'
);
alter table public.ai_watch_baseline enable row level security;
alter table public.ai_blocks enable row level security;
alter table public.ai_watch_runs enable row level security;
revoke all on public.ai_watch_baseline, public.ai_blocks, public.ai_watch_runs from public, anon, authenticated;

-- One alert row to the owner accounts, with a per-check cooldown. Push and
-- (trigger below) e-mail follow from the notifications insert.
create or replace function public._ops_notify(p_check text, p_cooldown interval, p_title text, p_body text)
 returns boolean language plpgsql security definer set search_path to '' as $$
begin
  insert into public.ops_alerts (check_name) values (p_check) on conflict do nothing;
  if coalesce((select last_fired from public.ops_alerts where check_name = p_check), '-infinity') >= now() - p_cooldown then
    return false;
  end if;
  insert into public.notifications (user_id, kind, category, title, body, url)
  select u.id, 'ops_alert', 'account', p_title, p_body, '/a'
  from (select user_id as id from public.admin_users
        union select '63aee5be-4eaa-409d-9c1e-f60c4daa5823'::uuid
        union select '73c89104-24ab-47c0-9c71-5fe7c82323dc'::uuid) u
  where exists (select 1 from auth.users au where au.id = u.id);
  update public.ops_alerts set last_fired = now(), last_detail = p_body, fired_count = fired_count + 1
    where check_name = p_check;
  return true;
end $$;
revoke all on function public._ops_notify(text, interval, text, text) from public, anon, authenticated;

-- Baseline rows for finished IST days that do not have one yet.
create or replace function public.ai_watch_baseline_refresh(p_days int default 28)
 returns int language plpgsql security definer set search_path to '' as $$
declare
  d date; n int := 0; t0 timestamptz; t1 timestamptz;
  today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  for d in select g::date from generate_series(greatest(today - p_days, date '2026-10-24'), today - 1, interval '1 day') g loop
    continue when exists (select 1 from public.ai_watch_baseline b where b.day = d);
    t0 := d::timestamp at time zone 'Asia/Kolkata';
    t1 := t0 + interval '1 day';
    insert into public.ai_watch_baseline (day, tok_day, tok_15m_max, tok_60m_max, key_ip_60m_max, key_dev_60m_max,
                                          top5_ip_share, nocookie_share, hour_tok, skip_peak)
    with x as (
      select ts, coalesce(output_tokens, 0) + coalesce(reasoning_tokens, 0) as o, ip_hash, dev_hash
      from public.llm_usage where ts >= t0 and ts < t1),
    hb as (select date_bin('1 hour', ts, t0) as b, sum(o) as s,
                  sum(o) filter (where ip_hash is not null) as sh from x group by 1),
    ki as (select date_bin('1 hour', ts, t0) as b, ip_hash, sum(o) as s from x where ip_hash is not null group by 1, 2),
    kd as (select date_bin('1 hour', ts, t0) as b, dev_hash, sum(o) as s from x where dev_hash is not null group by 1, 2),
    top5 as (select b, sum(s) as s from (select b, s, row_number() over (partition by b order by s desc) as r from ki) z
             where r <= 5 group by b),
    hr as (select extract(hour from ts at time zone 'Asia/Kolkata')::int as hh, sum(o) as s from x group by 1)
    select d,
      coalesce((select sum(o) from x), 0),
      coalesce((select max(s) from (select sum(o) as s from x group by date_bin('15 minutes', ts, t0)) q), 0),
      coalesce((select max(s) from hb), 0),
      (select max(s) from ki),
      (select max(s) from kd),
      (select avg(top5.s::numeric / hb.sh) from top5 join hb using (b) where hb.sh >= 50000),
      case when exists (select 1 from x where dev_hash is not null)
           then (select sum(o) filter (where dev_hash is null)::numeric / nullif(sum(o), 0) from x) end,
      array(select coalesce(hr.s, 0) from generate_series(0, 23) g left join hr on hr.hh = g order by g),
      exists (select 1 from public.ai_watch_runs r where r.verdict = 'attack' and r.ts >= t0 and r.ts < t1);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.ai_watch_baseline_refresh(int) from public, anon, authenticated;

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

-- Daily: baselines for yesterday, then clear caller hashes older than 48 h.
create or replace function public.ai_watch_daily()
 returns jsonb language plpgsql security definer set search_path to '' as $$
declare n int; m int;
begin
  n := public.ai_watch_baseline_refresh(28);
  update public.llm_usage set ip_hash = null, dev_hash = null
    where ts < now() - interval '48 hours' and ts > now() - interval '10 days'
      and (ip_hash is not null or dev_hash is not null);
  get diagnostics m = row_count;
  return jsonb_build_object('baselines_added', n, 'hashes_cleared', m);
end $$;
revoke all on function public.ai_watch_daily() from public, anon, authenticated;

-- E-mail every ops alert to the two pinned owner accounts. Pushes are held
-- 22:00-07:00 IST and can be missed away from the phone; mail is not held.
create or replace function public._ops_alert_mail()
 returns trigger language plpgsql security definer set search_path to '' as $$
declare em text;
begin
  if new.user_id not in ('63aee5be-4eaa-409d-9c1e-f60c4daa5823'::uuid, '73c89104-24ab-47c0-9c71-5fe7c82323dc'::uuid) then
    return new;
  end if;
  select email into em from auth.users where id = new.user_id;
  if em is null then return new; end if;
  perform net.http_post(
    url := 'https://stocksaathi.co.in/api/ai?op=ops-mail',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := jsonb_build_object('to', em, 'title', new.title, 'body', new.body),
    timeout_milliseconds := 10000);
  return new;
exception when others then
  return new;
end $$;
revoke all on function public._ops_alert_mail() from public, anon, authenticated;
create or replace trigger notifications_ops_mail
  after insert on public.notifications
  for each row when (new.kind = 'ops_alert') execute function public._ops_alert_mail();

-- ops_health_check without the fixed ai_spend_* checks (now ops_ai_watch).
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

select cron.schedule('ai-watch', '* * * * *', $$select public.ops_ai_watch()$$);
select cron.schedule('ai-watch-daily', '10 19 * * *', $$select public.ai_watch_daily()$$);
