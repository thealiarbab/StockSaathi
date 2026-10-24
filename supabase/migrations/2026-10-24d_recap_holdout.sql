-- =============================================================================
-- Recap holdout: 25% of users get neither the daily recap nor the weekly
-- report for the first weeks, so the effect on coming back can be measured
-- against people who lived through the same weeks without it (owner's call,
-- 24 Oct: 25%, not 10%; 10% of ~1,300 users is too few to tell 5 points from
-- chance).
--
-- Who: a stable hash of salt + user id, so a user is always in the same group
-- and a later experiment with another salt gets a fresh split. Checked on 24
-- Oct: 319 of 1,306 daily recipients (24.4%) and 346 of 1,361 weekly (25.4%),
-- with the same activity before launch (2.17 vs 2.04 active days of 14).
--
-- experiments.started_at is set when the crons go on; the comparison lives in
-- 2026-10-24e (retention tracking). Ending it: update experiments set ended_at =
-- now() where key = 'recap', and everyone gets recaps.
-- =============================================================================

create table if not exists public.experiments (
  key          text primary key,
  salt         text not null,
  holdout_mod  int  not null check (holdout_mod >= 2),   -- 1 in holdout_mod users is held out
  started_at   timestamptz,
  ended_at     timestamptz,
  note         text
);
alter table public.experiments enable row level security;
revoke all on table public.experiments from anon, authenticated;

insert into public.experiments (key, salt, holdout_mod, note)
values ('recap', 'recap-2026-10:', 4, 'Daily close recap + Sunday weekly report; 25% held out')
on conflict (key) do nothing;

-- True while the experiment runs and this user is in the held-out quarter.
create or replace function public.in_holdout(p_key text, p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select e.ended_at is null and abs(hashtext(e.salt || p_uid::text)) % e.holdout_mod = 0
                   from public.experiments e where e.key = p_key), false);
$$;

create or replace function public.send_daily_recap(p_dry boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d date := (now() at time zone 'Asia/Kolkata')::date;
  t0 timestamptz := (d::timestamp) at time zone 'Asia/Kolkata';
  v_all int; v_fresh int; v_hold int; v_ins int := 0;
begin
  if extract(isodow from d) > 5 then return jsonb_build_object('ok', true, 'skipped', 'weekend'); end if;
  select count(*), count(*) filter (where r.fresh_share >= 0.9 and r.pnl_paise is not null and r.base_paise > 0),
         count(*) filter (where r.fresh_share >= 0.9 and r.pnl_paise is not null and r.base_paise > 0 and public.in_holdout('recap', r.user_id))
    into v_all, v_fresh, v_hold from public.daily_recap_rows(d) r;
  if not p_dry then
    insert into public.notifications (user_id, kind, category, title, body, url, payload)
    select r.user_id, 'daily_recap', 'recap',
           case when r.pnl_paise = 0 then 'Your stocks closed flat today'
                else 'Your stocks today: ' || _signed_inr(r.pnl_paise) || ' (' || _signed_pct(100.0 * r.pnl_paise / r.base_paise) || ')' end,
           case when coalesce(r.top_pnl_paise, 0) = 0 then 'Tap to see how each one did.'
                else r.top_symbol || ' moved it most: ' || _signed_inr(r.top_pnl_paise) || '. Tap to see the rest.' end,
           '/portfolio',
           jsonb_build_object('day', d, 'pnl_paise', r.pnl_paise, 'base_paise', r.base_paise,
                              'top_symbol', r.top_symbol, 'top_pnl_paise', r.top_pnl_paise)
    from public.daily_recap_rows(d) r
    where r.fresh_share >= 0.9 and r.pnl_paise is not null and r.base_paise > 0
      and not public.in_holdout('recap', r.user_id)
      and not exists (select 1 from public.notifications n
                      where n.user_id = r.user_id and n.kind = 'daily_recap' and n.created_at >= t0);
    get diagnostics v_ins = row_count;
  end if;
  return jsonb_build_object('ok', true, 'dry_run', p_dry, 'day', d, 'users_with_stocks', v_all,
                            'fresh_enough', v_fresh, 'skipped_stale', v_all - v_fresh,
                            'holdout', v_hold, 'inserted', v_ins);
end;
$$;


create or replace function public.weekly_report_due(p_limit int default 3000)
returns table (user_id uuid, email text, display_name text, value_now bigint, value_then bigint,
               trades int, best_symbol text, best_pct numeric, worst_symbol text, worst_pct numeric)
language sql stable security definer set search_path = public as $$
  with wk as (select (now() at time zone 'Asia/Kolkata')::date as today),
  users as (
    select p.id, p.email, p.display_name
    from public.profiles p, wk
    where p.recap_emails and p.email like '%@%'
      and not public.in_holdout('recap', p.id)
      and not exists (select 1 from public.weekly_report_log l where l.user_id = p.id and l.week_of = wk.today)
      and (exists (select 1 from public.transactions t where t.user_id = p.id and t.created_at > now() - interval '30 days')
        or exists (select 1 from public.user_events e where e.user_id = p.id and e.occurred_at > now() - interval '30 days'))),
  snap as (
    select u.id,
      (select h.total_value_paise from public.portfolio_history h where h.user_id = u.id and h.source = 'daily_snapshot'
         and h.ts > now() - interval '7 days' order by h.ts desc limit 1) v_now,
      coalesce(
        (select h.total_value_paise from public.portfolio_history h where h.user_id = u.id and h.source = 'daily_snapshot'
           and h.ts <= now() - interval '7 days' order by h.ts desc limit 1),
        (select pf.starting_cash_paise from public.portfolios pf where pf.user_id = u.id)) v_then
    from users u),
  eod as (
    select (select max(trade_date) from public.nse_eod_prices where trade_date <= (select today from wk)) d1,
           (select max(trade_date) from public.nse_eod_prices where trade_date <= (select today from wk) - 7) d0),
  moves as (
    select h.user_id, h.symbol, 100.0 * (e1.close_paise - e0.close_paise) / e0.close_paise pct
    from public.holdings h cross join eod
    join public.nse_eod_prices e1 on e1.symbol = h.symbol and e1.trade_date = eod.d1
    join public.nse_eod_prices e0 on e0.symbol = h.symbol and e0.trade_date = eod.d0
    where h.qty > 0 and e0.close_paise > 0 and h.first_bought_at <= (eod.d0::timestamp + time '15:30') at time zone 'Asia/Kolkata')
  select u.id, u.email, u.display_name, s.v_now, s.v_then,
         (select count(*)::int from public.transactions t where t.user_id = u.id and t.created_at > now() - interval '7 days'),
         (select m.symbol from moves m where m.user_id = u.id order by m.pct desc limit 1),
         (select round(m.pct, 2) from moves m where m.user_id = u.id order by m.pct desc limit 1),
         (select m.symbol from moves m where m.user_id = u.id order by m.pct asc limit 1),
         (select round(m.pct, 2) from moves m where m.user_id = u.id order by m.pct asc limit 1)
  from users u join snap s on s.id = u.id
  where s.v_now is not null and s.v_then > 0
  limit greatest(1, least(p_limit, 5000));
$$;


revoke all on function public.in_holdout(text, uuid) from public, anon, authenticated;
revoke all on function public.send_daily_recap(boolean) from public, anon, authenticated;
revoke all on function public.weekly_report_due(int) from public, anon, authenticated;
grant execute on function public.weekly_report_due(int) to service_role;
