-- =============================================================================
-- Retention tracking: a permanent record of every recap / report / fill email
-- decision and what came of it, so "did it work?" is one query, never "we
-- forgot to track that" (owner, 24 Oct).
--
-- outbound_log      one row per (kind, day, user): sent, held_out (the 25%
--                   holdout), skipped_stale (prices not fresh), opted_out,
--                   send_failed. The holdout is logged on the days it WOULD
--                   have been sent, so both groups are counted the same way
--                   (intent to treat).
-- email_log         one row per email Resend accepted: its Resend id, then
--                   delivered / opened / clicked / bounced / complained from
--                   the hourly email-status poll, and our own first click.
-- notifications     opened_at / opened_via: tapped from a push ('push') or
--                   in the bell ('bell').
-- pref_log          every change to order / recap emails and push on or off.
-- experiment_daily  written every night at 23:50 IST, per group: cohort,
--                   active that day, active in the last 7 days, came back the
--                   day after a recap. Kept forever: the history does not
--                   depend on today's code.
-- retention_scoreboard(days)  all of it in one JSON (admins / service role).
--
-- Written without DROP / DELETE (the Supabase connector cannot run them).
-- =============================================================================

-- ---- Tables --------------------------------------------------------------------

create table if not exists public.outbound_log (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('daily_recap','weekly_report','fill_email')),
  day              date not null,
  user_id          uuid not null,
  grp              text not null check (grp in ('treatment','holdout','none')),
  status           text not null check (status in ('sent','held_out','skipped_stale','opted_out','send_failed')),
  notification_id  uuid,
  email_id         uuid,
  detail           jsonb not null default '{}',
  created_at       timestamptz not null default now(),
  unique (kind, day, user_id)
);
create index if not exists outbound_log_day on public.outbound_log (day, kind);
create index if not exists outbound_log_user on public.outbound_log (user_id, day);
alter table public.outbound_log enable row level security;
revoke all on table public.outbound_log from anon, authenticated;

create table if not exists public.email_log (
  id               uuid primary key,          -- made by the sender, put in every link as ss_e
  kind             text not null check (kind in ('weekly_report','fill_email')),
  user_id          uuid not null,
  resend_id        text,
  subject          text,
  notification_ids uuid[],
  sent_at          timestamptz not null default now(),
  last_event       text not null default 'sent',
  last_event_at    timestamptz,
  checked_at       timestamptz,
  check_count      int not null default 0,
  first_click_at   timestamptz,
  click_count      int not null default 0
);
create index if not exists email_log_check on public.email_log (checked_at nulls first) where resend_id is not null;
create index if not exists email_log_user on public.email_log (user_id, sent_at);
alter table public.email_log enable row level security;
revoke all on table public.email_log from anon, authenticated;

alter table public.notifications add column if not exists opened_at timestamptz;
alter table public.notifications add column if not exists opened_via text;

create table if not exists public.pref_log (
  id       bigserial primary key,
  user_id  uuid not null,
  what     text not null,            -- order_emails | recap_emails | push
  value    text not null,            -- on | off | categories list
  at       timestamptz not null default now()
);
create index if not exists pref_log_at on public.pref_log (at);
alter table public.pref_log enable row level security;
revoke all on table public.pref_log from anon, authenticated;

create table if not exists public.experiment_daily (
  day               date not null,
  key               text not null,
  grp               text not null,
  cohort            int not null,      -- users ever eligible (sent or held out) up to this day
  eligible_today    int not null,      -- eligible for a recap today (sent + held out)
  active_today      int not null,
  active_last_7     int not null,
  back_next_day     int,               -- of yesterday's eligible, active today
  eligible_yesterday int,
  opened_today      int,               -- recaps / reports opened today (treatment only)
  written_at        timestamptz not null default now(),
  primary key (day, key, grp)
);
alter table public.experiment_daily enable row level security;
revoke all on table public.experiment_daily from anon, authenticated;

-- ---- Preference changes ----------------------------------------------------------

create or replace function public._log_profile_prefs()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.order_emails is distinct from old.order_emails then
    insert into public.pref_log (user_id, what, value) values (new.id, 'order_emails', case when new.order_emails then 'on' else 'off' end);
  end if;
  if new.recap_emails is distinct from old.recap_emails then
    insert into public.pref_log (user_id, what, value) values (new.id, 'recap_emails', case when new.recap_emails then 'on' else 'off' end);
  end if;
  return new;
end;
$$;
create or replace trigger trg_log_profile_prefs after update of order_emails, recap_emails on public.profiles
  for each row execute function public._log_profile_prefs();

create or replace function public._log_push_prefs()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.disabled is distinct from old.disabled or new.categories is distinct from old.categories then
    insert into public.pref_log (user_id, what, value)
    values (new.user_id, 'push', case when new.disabled then 'off' else 'on:' || array_to_string(new.categories, ',') end);
  end if;
  return new;
end;
$$;
create or replace trigger trg_log_push_prefs after insert or update on public.push_subscriptions
  for each row execute function public._log_push_prefs();

-- ---- Daily recap, now logged ---------------------------------------------------

create or replace function public.send_daily_recap(p_dry boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d date := (now() at time zone 'Asia/Kolkata')::date;
  t0 timestamptz := (d::timestamp) at time zone 'Asia/Kolkata';
  v_all int; v_fresh int; v_hold int; v_ins int := 0; v_logged int := 0;
begin
  if extract(isodow from d) > 5 then return jsonb_build_object('ok', true, 'skipped', 'weekend'); end if;
  create temp table _recap on commit drop as
    select r.*, public.in_holdout('recap', r.user_id) held,
           (r.fresh_share >= 0.9 and r.pnl_paise is not null and r.base_paise > 0) ok
    from public.daily_recap_rows(d) r;
  select count(*), count(*) filter (where ok), count(*) filter (where ok and held)
    into v_all, v_fresh, v_hold from _recap;
  if not p_dry then
    with todo as (
      select * from _recap r
      where r.ok and not r.held
        and not exists (select 1 from public.notifications n
                        where n.user_id = r.user_id and n.kind = 'daily_recap' and n.created_at >= t0)),
    ins as (
      insert into public.notifications (user_id, kind, category, title, body, url, payload)
      select r.user_id, 'daily_recap', 'recap',
             case when r.pnl_paise = 0 then 'Your stocks closed flat today'
                  else 'Your stocks today: ' || _signed_inr(r.pnl_paise) || ' (' || _signed_pct(100.0 * r.pnl_paise / r.base_paise) || ')' end,
             case when coalesce(r.top_pnl_paise, 0) = 0 then 'Tap to see how each one did.'
                  else r.top_symbol || ' moved it most: ' || _signed_inr(r.top_pnl_paise) || '. Tap to see the rest.' end,
             '/portfolio',
             jsonb_build_object('day', d, 'pnl_paise', r.pnl_paise, 'base_paise', r.base_paise,
                                'top_symbol', r.top_symbol, 'top_pnl_paise', r.top_pnl_paise)
      from todo r
      returning id, user_id),
    logged as (
      insert into public.outbound_log (kind, day, user_id, grp, status, notification_id, detail)
      select 'daily_recap', d, r.user_id,
             case when r.held then 'holdout' else 'treatment' end,
             case when not r.ok then 'skipped_stale' when r.held then 'held_out' else 'sent' end,
             ins.id,
             jsonb_build_object('pnl_paise', r.pnl_paise, 'base_paise', r.base_paise, 'fresh_share', r.fresh_share)
      from _recap r left join ins on ins.user_id = r.user_id
      where ins.id is not null or not r.ok or r.held
      on conflict (kind, day, user_id) do nothing
      returning 1)
    select (select count(*) from ins), (select count(*) from logged) into v_ins, v_logged;
  end if;
  return jsonb_build_object('ok', true, 'dry_run', p_dry, 'day', d, 'users_with_stocks', v_all,
                            'fresh_enough', v_fresh, 'skipped_stale', v_all - v_fresh,
                            'holdout', v_hold, 'inserted', v_ins, 'logged', v_logged);
end;
$$;

-- ---- Weekly report, now logged -------------------------------------------------

-- Active users the weekly report is NOT going to: the holdout and those who
-- turned it off. Logged once per Sunday, before the sends.
create or replace function public.log_weekly_skips()
returns int language plpgsql security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Kolkata')::date; n int;
begin
  insert into public.outbound_log (kind, day, user_id, grp, status)
  select 'weekly_report', d, p.id,
         case when public.in_holdout('recap', p.id) then 'holdout' else 'treatment' end,
         case when not p.recap_emails then 'opted_out' else 'held_out' end
  from public.profiles p
  where p.email like '%@%'
    and (public.in_holdout('recap', p.id) or not p.recap_emails)
    -- Same bar as weekly_report_due, so both groups are the same kind of user.
    and exists (select 1 from public.portfolio_history h where h.user_id = p.id and h.source = 'daily_snapshot'
                and h.ts > now() - interval '7 days')
    and (exists (select 1 from public.transactions t where t.user_id = p.id and t.created_at > now() - interval '30 days')
      or exists (select 1 from public.user_events e where e.user_id = p.id and e.occurred_at > now() - interval '30 days'))
  on conflict (kind, day, user_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- After a batch Resend accepted: rows {user_id, email_id, resend_id, subject, title, body}.
create or replace function public.mark_weekly_report_sent(p_rows jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Kolkata')::date; n int;
begin
  create temp table _wk on commit drop as
    select (x->>'user_id')::uuid uid, nullif(x->>'email_id', '')::uuid email_id, x->>'resend_id' resend_id,
           x->>'subject' subject, x->>'title' title, x->>'body' body
    from jsonb_array_elements(p_rows) x;
  insert into public.weekly_report_log (user_id, week_of) select uid, d from _wk on conflict do nothing;
  insert into public.email_log (id, kind, user_id, resend_id, subject)
    select email_id, 'weekly_report', uid, resend_id, subject from _wk where email_id is not null
    on conflict (id) do nothing;
  with ins as (
    insert into public.notifications (user_id, kind, category, title, body, url, payload)
    select w.uid, 'weekly_report', 'recap', left(w.title, 140), left(w.body, 300), '/report-card', jsonb_build_object('week_of', d)
    from _wk w
    where not exists (select 1 from public.notifications n where n.user_id = w.uid and n.kind = 'weekly_report'
                      and n.created_at >= (d::timestamp) at time zone 'Asia/Kolkata')
    returning id, user_id)
  insert into public.outbound_log (kind, day, user_id, grp, status, notification_id, email_id)
  select 'weekly_report', d, w.uid, 'treatment', 'sent', ins.id, w.email_id
  from _wk w left join ins on ins.user_id = w.uid
  on conflict (kind, day, user_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- A batch Resend refused: rows {user_id, error}.
create or replace function public.log_send_failed(p_kind text, p_rows jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Kolkata')::date; n int;
begin
  insert into public.outbound_log (kind, day, user_id, grp, status, detail)
  select p_kind, d, (x->>'user_id')::uuid,
         case when p_kind = 'fill_email' then 'none' else 'treatment' end, 'send_failed',
         jsonb_build_object('error', left(x->>'error', 300))
  from jsonb_array_elements(p_rows) x
  on conflict (kind, day, user_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---- Fill emails, now logged ---------------------------------------------------

-- Rows {user_id, email_id, resend_id, subject, ids: [notification ids]}.
create or replace function public.log_fill_emails(p_rows jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Kolkata')::date; n int;
begin
  create temp table _fe on commit drop as
    select (x->>'user_id')::uuid uid, (x->>'email_id')::uuid email_id, x->>'resend_id' resend_id, x->>'subject' subject,
           array(select jsonb_array_elements_text(x->'ids'))::uuid[] ids
    from jsonb_array_elements(p_rows) x;
  update public.notifications n set emailed_at = now()
    from _fe f where n.id = any(f.ids) and n.emailed_at is null;
  insert into public.email_log (id, kind, user_id, resend_id, subject, notification_ids)
    select email_id, 'fill_email', uid, resend_id, subject, ids from _fe on conflict (id) do nothing;
  insert into public.outbound_log (kind, day, user_id, grp, status, email_id, detail)
    select 'fill_email', d, uid, 'none', 'sent', email_id, jsonb_build_object('fills', cardinality(ids)) from _fe
    on conflict (kind, day, user_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---- Delivery status (handlers/email-status.py, hourly) ------------------------

create or replace function public.email_status_due(p_limit int default 300)
returns table (id uuid, resend_id text)
language sql stable security definer set search_path = public as $$
  select e.id, e.resend_id from public.email_log e
  where e.resend_id is not null
    and e.sent_at < now() - interval '30 minutes' and e.sent_at > now() - interval '7 days'
    and e.last_event not in ('bounced', 'complained', 'clicked')
    and (e.checked_at is null or e.checked_at < now() - interval '6 hours')
  order by e.checked_at nulls first, e.sent_at
  limit greatest(1, least(p_limit, 1000));
$$;

-- Rows {id, last_event, at}.
create or replace function public.set_email_status(p_rows jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.email_log e
     set last_event = coalesce(nullif(x->>'last_event', ''), e.last_event),
         last_event_at = coalesce(nullif(x->>'at', '')::timestamptz, e.last_event_at),
         checked_at = now(), check_count = e.check_count + 1
    from jsonb_array_elements(p_rows) x
   where e.id = (x->>'id')::uuid;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---- Opens and clicks (called from the page, signed in or not) -------------------
-- The ids are random UUIDs that only the recipient has, in their own push or
-- email link. Only the first open is stamped; clicks are counted.

create or replace function public.log_notif_open(p_id uuid, p_via text default 'bell')
returns void language sql security definer set search_path = public as $$
  update public.notifications set opened_at = now(), opened_via = case when p_via = 'push' then 'push' else 'bell' end
  where id = p_id and opened_at is null;
$$;

create or replace function public.log_email_click(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.email_log set first_click_at = coalesce(first_click_at, now()), click_count = click_count + 1
  where id = p_id;
$$;

-- ---- Nightly experiment snapshot -------------------------------------------------

create or replace function public.snapshot_experiment_daily(p_day date default (now() at time zone 'Asia/Kolkata')::date)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.experiment_daily (day, key, grp, cohort, eligible_today, active_today, active_last_7,
                                       back_next_day, eligible_yesterday, opened_today)
  with elig as (
    select distinct o.user_id, o.grp from public.outbound_log o
    where o.kind in ('daily_recap', 'weekly_report') and o.status in ('sent', 'held_out') and o.day <= p_day),
  today as (
    select distinct o.user_id, o.grp from public.outbound_log o
    where o.kind = 'daily_recap' and o.status in ('sent', 'held_out') and o.day = p_day),
  prev_day as (select max(o.day) d from public.outbound_log o where o.kind = 'daily_recap' and o.day < p_day),
  yest as (
    select distinct o.user_id, o.grp from public.outbound_log o, prev_day
    where o.kind = 'daily_recap' and o.status in ('sent', 'held_out') and o.day = prev_day.d),
  act as (
    select e.user_id, (e.occurred_at at time zone 'Asia/Kolkata')::date d
    from public.user_events e
    where e.occurred_at >= ((p_day - 7)::timestamp) at time zone 'Asia/Kolkata'
      and e.occurred_at < ((p_day + 1)::timestamp) at time zone 'Asia/Kolkata'
    group by 1, 2)
  select p_day, 'recap', g.grp,
         (select count(*) from elig where elig.grp = g.grp),
         (select count(*) from today where today.grp = g.grp),
         (select count(*) from elig where elig.grp = g.grp and exists (select 1 from act where act.user_id = elig.user_id and act.d = p_day)),
         (select count(*) from elig where elig.grp = g.grp and exists (select 1 from act where act.user_id = elig.user_id and act.d > p_day - 7)),
         (select count(*) from yest where yest.grp = g.grp and exists (select 1 from act where act.user_id = yest.user_id and act.d = p_day)),
         (select count(*) from yest where yest.grp = g.grp),
         (select count(*) from public.notifications n where n.kind in ('daily_recap', 'weekly_report')
            and (n.opened_at at time zone 'Asia/Kolkata')::date = p_day
            and exists (select 1 from elig where elig.user_id = n.user_id and elig.grp = g.grp))
  from (values ('treatment'), ('holdout')) g(grp)
  where exists (select 1 from public.experiments x where x.key = 'recap' and x.started_at is not null)
  on conflict (day, key, grp) do update set
    cohort = excluded.cohort, eligible_today = excluded.eligible_today, active_today = excluded.active_today,
    active_last_7 = excluded.active_last_7, back_next_day = excluded.back_next_day,
    eligible_yesterday = excluded.eligible_yesterday, opened_today = excluded.opened_today, written_at = now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---- Scoreboard ------------------------------------------------------------------

create or replace function public.retention_scoreboard(p_days int default 14)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare since timestamptz := now() - make_interval(days => greatest(1, least(p_days, 365))); out jsonb;
begin
  -- API callers: service role or an admin. Direct SQL (no API role) is the owner.
  if coalesce(auth.role(), '') in ('anon', 'authenticated') and not coalesce(public.is_admin(), false) then
    raise exception 'admins only';
  end if;
  select jsonb_build_object(
    'since', since,
    'push_ask', (select coalesce(jsonb_object_agg(o, c), '{}') from (
        select coalesce(props->>'outcome', '?') o, count(*) c from public.user_events
        where kind = 'push_ask' and occurred_at >= since group by 1) x),
    'push_devices', jsonb_build_object(
        'active_now', (select count(*) from public.push_subscriptions where not disabled),
        'users_now', (select count(distinct user_id) from public.push_subscriptions where not disabled),
        'added_in_period', (select count(*) from public.push_subscriptions where created_at >= since)),
    'sends', (select coalesce(jsonb_agg(x order by x.kind, x.status), '[]') from (
        select kind, status, grp, count(*) n from public.outbound_log where created_at >= since group by 1, 2, 3) x),
    'emails', (select coalesce(jsonb_agg(x order by x.kind), '[]') from (
        select kind, count(*) sent,
               count(*) filter (where last_event in ('delivered', 'opened', 'clicked')) delivered,
               count(*) filter (where last_event in ('opened', 'clicked')) opened,
               count(*) filter (where first_click_at is not null or last_event = 'clicked') clicked,
               count(*) filter (where last_event = 'bounced') bounced,
               count(*) filter (where last_event = 'complained') complained,
               count(*) filter (where checked_at is null) not_checked_yet
        from public.email_log where sent_at >= since group by 1) x),
    'notifications', (select coalesce(jsonb_agg(x order by x.kind), '[]') from (
        select kind, count(*) made,
               count(*) filter (where push_state = 'sent') pushed,
               count(*) filter (where push_state = 'failed') push_failed,
               count(*) filter (where read_at is not null) read,
               count(*) filter (where opened_via = 'push') opened_from_push,
               count(*) filter (where opened_via = 'bell') opened_in_bell
        from public.notifications where created_at >= since
          and kind in ('order_filled', 'daily_recap', 'weekly_report') group by 1) x),
    'pref_changes', (select coalesce(jsonb_agg(x), '[]') from (
        select what, value, count(*) n from public.pref_log where at >= since group by 1, 2) x),
    'experiment', jsonb_build_object(
        'config', (select to_jsonb(e) from public.experiments e where e.key = 'recap'),
        'by_group', (select coalesce(jsonb_agg(x order by x.grp), '[]') from (
            select grp, sum(eligible_yesterday) eligible_days, sum(back_next_day) came_back_next_day,
                   round(100.0 * sum(back_next_day) / nullif(sum(eligible_yesterday), 0), 1) next_day_return_pct,
                   (array_agg(active_last_7 order by day desc))[1] active_last_7_latest,
                   (array_agg(cohort order by day desc))[1] cohort_latest,
                   round(100.0 * (array_agg(active_last_7 order by day desc))[1] / nullif((array_agg(cohort order by day desc))[1], 0), 1) active_7d_pct,
                   count(*) days_recorded
            from public.experiment_daily where key = 'recap' and day >= since::date group by grp) x))
  ) into out;
  return out;
end;
$$;

-- ---- Grants ----------------------------------------------------------------------

revoke all on function public._log_profile_prefs() from public, anon, authenticated;
revoke all on function public._log_push_prefs() from public, anon, authenticated;
revoke all on function public.send_daily_recap(boolean) from public, anon, authenticated;
revoke all on function public.log_weekly_skips() from public, anon, authenticated;
revoke all on function public.mark_weekly_report_sent(jsonb) from public, anon, authenticated;
revoke all on function public.log_send_failed(text, jsonb) from public, anon, authenticated;
revoke all on function public.log_fill_emails(jsonb) from public, anon, authenticated;
revoke all on function public.email_status_due(int) from public, anon, authenticated;
revoke all on function public.set_email_status(jsonb) from public, anon, authenticated;
revoke all on function public.snapshot_experiment_daily(date) from public, anon, authenticated;
revoke all on function public.retention_scoreboard(int) from public, anon;
grant execute on function public.log_weekly_skips() to service_role;
grant execute on function public.mark_weekly_report_sent(jsonb) to service_role;
grant execute on function public.log_send_failed(text, jsonb) to service_role;
grant execute on function public.log_fill_emails(jsonb) to service_role;
grant execute on function public.email_status_due(int) to service_role;
grant execute on function public.set_email_status(jsonb) to service_role;
grant execute on function public.retention_scoreboard(int) to service_role, authenticated;
revoke all on function public.log_notif_open(uuid, text) from public;
revoke all on function public.log_email_click(uuid) from public;
grant execute on function public.log_notif_open(uuid, text) to anon, authenticated;
grant execute on function public.log_email_click(uuid) to anon, authenticated;

-- ---- Schedules (tracking only; nothing here sends anything) -----------------------

select cron.schedule('email-status', '15 * * * *', $job$
  select net.http_post(
    url := 'https://stocksaathi.co.in/api/email-status',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$job$);
select cron.schedule('experiment-daily', '20 18 * * *', $job$ select public.snapshot_experiment_daily(); $job$);
