-- =============================================================================
-- Recaps: a daily "your stocks today" note after the close, and a weekly
-- "your week" report on Sunday. Both are a reason to come back that is about
-- the user's own portfolio, true to the paisa, and nothing invented.
--
-- Daily (send_daily_recap): one notification per user with stocks, kind
-- 'daily_recap', new category 'recap'. The bell gets it; push only reaches a
-- device that has 'recap' in its categories. It runs after the 16:00 IST
-- portfolio-snapshot job, which prices every held symbol live and writes
-- quote_cache, so prices come from that. A user is skipped when under 90% of
-- their stock value has a quote refreshed after today's 15:30 close: a wrong
-- number is worse than no note. On a market holiday nothing is refreshed, so
-- nobody gets one. Mutual funds (MF_*) are left out: their NAV comes later.
--
--   Day P&L per symbol = q_now*price - q_open*prev_close - bought + sold,
--   q_open = q_now - bought_qty + sold_qty (today's trades), so a stock bought
--   today counts from its buy price, not from yesterday's close.
--
-- Weekly (weekly_report_due / mark_weekly_report_sent): rows for
-- handlers/weekly-report.py, which emails users active in the last 30 days
-- who left recap emails on (profiles.recap_emails), then logs them in
-- weekly_report_log (one per user per week) and adds a bell/push note.
--
-- Nothing here is scheduled. The crons are added once the owner says go.
-- Written without DROP / DELETE except the check constraint swap (same as
-- 2026-10-14d).
-- =============================================================================

alter table public.notifications drop constraint if exists notifications_category_check;
alter table public.notifications add constraint notifications_category_check
  check (category in ('orders','account','coach','achievements','recap'));

alter table public.push_subscriptions alter column categories
  set default array['orders','account','coach','achievements','recap'];
-- Devices that took the "everything" default get the new category too; a
-- device that picked categories by hand keeps exactly its choice.
update public.push_subscriptions
   set categories = categories || array['recap']
 where categories @> array['orders','account','coach','achievements'] and not ('recap' = any(categories));

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_categories text[] default null, p_user_agent text default null, p_disabled boolean default false)
returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_endpoint !~ '^https://' or length(p_endpoint) > 1000 then raise exception 'bad endpoint'; end if;
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth, categories, user_agent, disabled)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth,
          coalesce(p_categories, array['orders','account','coach','achievements','recap']), left(p_user_agent, 200), p_disabled)
  on conflict (endpoint) do update
     set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth,
         categories = coalesce(p_categories, public.push_subscriptions.categories),
         user_agent = excluded.user_agent, disabled = p_disabled, fail_count = 0;
end;
$function$;

alter table public.profiles add column if not exists recap_emails boolean not null default true;

-- '+₹1,234.50' / '−₹87.00' with Indian grouping, as the fill notices write it.
create or replace function public._signed_inr(p_paise bigint)
returns text language sql immutable as $$
  select case when p_paise < 0 then '−' else '+' end
      || '₹' || to_char(abs(p_paise) / 100.0, 'FM99,99,99,99,990.00');
$$;
create or replace function public._signed_pct(p numeric)
returns text language sql immutable as $$
  select case when p < 0 then '−' else '+' end || to_char(abs(p), 'FM9990.00') || '%';
$$;

-- ---- Daily ---------------------------------------------------------------------

create or replace function public.daily_recap_rows(p_day date default (now() at time zone 'Asia/Kolkata')::date)
returns table (user_id uuid, pnl_paise bigint, base_paise bigint, top_symbol text, top_pnl_paise bigint, fresh_share numeric)
language sql stable security definer set search_path = public as $$
  with b as (
    select (p_day::timestamp) at time zone 'Asia/Kolkata' as t0,
           (p_day::timestamp + time '15:30') at time zone 'Asia/Kolkata' as tclose),
  tx as (
    select t.user_id, t.symbol,
           sum(t.qty) filter (where t.side = 'BUY') qb, sum(t.qty) filter (where t.side = 'SELL') qs,
           sum(t.value_paise) filter (where t.side = 'BUY') bv, sum(t.value_paise) filter (where t.side = 'SELL') sv
    from public.transactions t, b
    where t.created_at >= b.t0 and t.symbol not like 'MF\_%'
    group by 1, 2),
  pos as (
    select coalesce(h.user_id, tx.user_id) user_id, coalesce(h.symbol, tx.symbol) symbol,
           coalesce(h.qty, 0) q1, coalesce(h.avg_cost_paise, 0) cost,
           coalesce(tx.qb, 0) qb, coalesce(tx.qs, 0) qs, coalesce(tx.bv, 0) bv, coalesce(tx.sv, 0) sv
    from (select * from public.holdings where qty > 0 and symbol not like 'MF\_%') h
    full join tx on tx.user_id = h.user_id and tx.symbol = h.symbol),
  per as (
    select p.user_id, p.symbol, p.bv,
           (q.updated_at >= b.tclose and q.price_paise > 0 and q.prev_close_paise > 0) fresh,
           p.q1 * q.price_paise - (p.q1 - p.qb + p.qs) * q.prev_close_paise - p.bv + p.sv pnl,
           (p.q1 - p.qb + p.qs) * coalesce(q.prev_close_paise, p.cost) v0,
           greatest(p.q1 * coalesce(q.price_paise, p.cost), p.q1 * p.cost, p.bv) w
    from pos p cross join b left join public.quote_cache q on q.symbol = p.symbol)
  select user_id,
         round(sum(pnl) filter (where fresh))::bigint,
         round(sum(v0) filter (where fresh) + sum(bv) filter (where fresh))::bigint,
         (array_agg(symbol order by abs(pnl) desc nulls last) filter (where fresh))[1],
         round((array_agg(pnl order by abs(pnl) desc nulls last) filter (where fresh))[1])::bigint,
         case when sum(w) > 0 then round(coalesce(sum(w) filter (where fresh), 0) / sum(w), 4) else 0 end
  from per group by user_id
  -- A test account holds 999,999,999,999 shares at ₹0 (12 Sep): no real
  -- portfolio is worth ₹10 lakh crore, and its sums would overflow bigint.
  having coalesce(sum(w), 0) < 1e15;
$$;

-- p_dry: count only. Returns what it did (or would do).
create or replace function public.send_daily_recap(p_dry boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d date := (now() at time zone 'Asia/Kolkata')::date;
  t0 timestamptz := (d::timestamp) at time zone 'Asia/Kolkata';
  v_all int; v_fresh int; v_ins int := 0;
begin
  if extract(isodow from d) > 5 then return jsonb_build_object('ok', true, 'skipped', 'weekend'); end if;
  select count(*), count(*) filter (where r.fresh_share >= 0.9 and r.pnl_paise is not null and r.base_paise > 0)
    into v_all, v_fresh from public.daily_recap_rows(d) r;
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
      and not exists (select 1 from public.notifications n
                      where n.user_id = r.user_id and n.kind = 'daily_recap' and n.created_at >= t0);
    get diagnostics v_ins = row_count;
  end if;
  return jsonb_build_object('ok', true, 'dry_run', p_dry, 'day', d, 'users_with_stocks', v_all,
                            'fresh_enough', v_fresh, 'skipped_stale', v_all - v_fresh, 'inserted', v_ins);
end;
$$;

-- ---- Weekly --------------------------------------------------------------------

create table if not exists public.weekly_report_log (
  user_id   uuid not null,
  week_of   date not null,          -- the Sunday it was sent
  sent_at   timestamptz not null default now(),
  primary key (user_id, week_of)
);
alter table public.weekly_report_log enable row level security;
revoke all on table public.weekly_report_log from anon, authenticated;

create or replace function public.weekly_report_due(p_limit int default 3000)
returns table (user_id uuid, email text, display_name text, value_now bigint, value_then bigint,
               trades int, best_symbol text, best_pct numeric, worst_symbol text, worst_pct numeric)
language sql stable security definer set search_path = public as $$
  with wk as (select (now() at time zone 'Asia/Kolkata')::date as today),
  users as (
    select p.id, p.email, p.display_name
    from public.profiles p, wk
    where p.recap_emails and p.email like '%@%'
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

-- After the email went out: log it, and leave the same summary in the bell.
create or replace function public.mark_weekly_report_sent(p_rows jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Kolkata')::date; n int;
begin
  with r as (
    select (x->>'user_id')::uuid uid, (x->>'title') title, (x->>'body') body
    from jsonb_array_elements(p_rows) x),
  ins as (
    insert into public.weekly_report_log (user_id, week_of)
    select uid, d from r on conflict do nothing returning user_id)
  insert into public.notifications (user_id, kind, category, title, body, url, payload)
  select r.uid, 'weekly_report', 'recap', left(r.title, 140), left(r.body, 300), '/report-card', jsonb_build_object('week_of', d)
  from r join ins on ins.user_id = r.uid;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.daily_recap_rows(date) from public, anon, authenticated;
revoke all on function public.send_daily_recap(boolean) from public, anon, authenticated;
revoke all on function public.weekly_report_due(int) from public, anon, authenticated;
revoke all on function public.mark_weekly_report_sent(jsonb) from public, anon, authenticated;
grant execute on function public.weekly_report_due(int) to service_role;
grant execute on function public.mark_weekly_report_sent(jsonb) to service_role;
