-- Raw web_events kept for 3 days (today + the 2 before, IST); daily totals in
-- web_event_daily are kept forever. Owner's decision, 25 Oct 2026, after the
-- database passed the Free plan's 500 MB (554 MB; web_events ~475 MB with
-- indexes) and the Nano instance ran out of memory and disk budget.
-- Replaces the 18 Oct "keep raw forever" decision (2026-10-18b).

-- Deletes in batches so a night's work never hogs the disk. Never removes a
-- day whose totals are not in web_event_daily yet.
create or replace function public.prune_web_events(p_keep_days integer default 3, p_batch integer default 50000)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz := (date_trunc('day', now() at time zone 'Asia/Kolkata') - make_interval(days => p_keep_days - 1)) at time zone 'Asia/Kolkata';
  rolled timestamptz;
  n integer;
begin
  if not pg_try_advisory_xact_lock(hashtext('prune_web_events')) then return -1; end if;
  select ((max(day) + 1)::timestamp) at time zone 'Asia/Kolkata' into rolled from web_event_daily;
  if rolled is null then return 0; end if;
  cutoff := least(cutoff, rolled);
  delete from web_events where id in (
    select id from web_events where ts < cutoff order by ts limit p_batch);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.prune_web_events(integer, integer) from public, anon, authenticated;

-- 02:30–04:20 IST, every 10 min (after web-events-rollup at 01:55 IST).
select cron.schedule('web-events-prune', '*/10 21-22 * * *',
  $c$set statement_timeout = '5min'; select public.prune_web_events();$c$);

-- One-off: rewrite the table after the first night's backlog (~450k rows) is
-- gone, so the freed space is given back (plain DELETE does not shrink it).
-- 04:30 IST 26 Oct. Unschedule 'web-events-shrink-once' afterwards.
select cron.schedule('web-events-shrink-once', '0 23 25 10 *', 'VACUUM FULL public.web_events');
