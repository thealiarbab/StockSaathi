-- Source queries for scripts/data/public_stats.json. Run read-only in the
-- Supabase SQL editor; publish percentages and rankings only, never counts.
-- Sector shares and Nifty 50 membership are mapped locally from
-- js/data/universeFull.json (the same labels the Markets page shows).

-- Real accounts: everyone except owner/admin accounts, qa_* bots, temp-mail
-- domains, *.test addresses and the test account holding 1e9+ shares.
with real as (
  select p.id from public.profiles p
  where not exists (select 1 from public.admin_users a where a.user_id = p.id)
    and coalesce(lower(p.username), '') <> 'admin'
    and coalesce(lower(p.username), '') not like 'qa\_%'
    and lower(split_part(coalesce(p.email, ''), '@', 2)) not in
        ('oemails.com', 'copytosh.com', '37xiao.com', '93301.com', 'dgfxvb.gy')
    and lower(coalesce(p.email, '')) not like '%.test'
    and not exists (select 1 from public.holdings h where h.user_id = p.id and h.qty >= 1e9)),
tr as (select t.* from public.transactions t join real r on r.id = t.user_id),
fb as (select distinct on (user_id) user_id, symbol from tr where side = 'BUY' order by user_id, created_at),
traders as (select distinct user_id from tr),
rs as (select distinct e.user_id from public.user_events e join real r on r.id = e.user_id where e.kind = 'replay_start'),
rf as (select distinct e.user_id from public.user_events e join real r on r.id = e.user_id where e.kind = 'replay_finish'),
lo as (select distinct o.user_id from public.limit_orders o join real r on r.id = o.user_id
       where coalesce(o.order_type, 'LIMIT') in ('LIMIT', 'AMO_MARKET')),
co as (select distinct c.user_id from public.coach_messages c join real r on r.id = c.user_id where c.event_type = 'chat_user')
select
  -- symbol:count lists, mapped to shares and sectors locally
  (select string_agg(symbol || ':' || n, ',' order by n desc) from (select symbol, count(*) n from fb group by 1) x) as first_buys,
  (select string_agg(symbol || ':' || n, ',' order by n desc)
     from (select symbol, count(*) n from tr group by 1 order by 2 desc limit 400) x) as trades,
  (select count(*) from fb) as first_buyers_denominator,
  (select count(*) from tr) as trades_denominator,
  round(100.0 * (select count(*) from traders) / (select count(*) from real), 1) as pct_accounts_traded,
  round(100.0 * (select count(*) from rf) / nullif((select count(*) from rs), 0), 1) as pct_replay_finished,
  round(100.0 * (select count(*) from lo where user_id in (select user_id from traders))
        / (select count(*) from traders), 1) as pct_traders_used_limit_amo,
  round(100.0 * (select count(*) from co) / (select count(*) from real), 1) as pct_accounts_asked_coach,
  round(100.0 * (select count(*) from tr where side = 'BUY') / (select count(*) from tr), 1) as pct_trades_buys,
  -- bias_flags are written at trade time since the 24 Oct detector rewrite
  round(100.0 * (select count(*) from tr where side = 'SELL' and created_at >= '2026-10-24 18:30+05:30'
                   and bias_flags::text ilike '%panic%')
        / nullif((select count(*) from tr where side = 'SELL' and created_at >= '2026-10-24 18:30+05:30'), 0), 2)
    as pct_sells_panic_pattern;
