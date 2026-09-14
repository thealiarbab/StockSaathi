-- =============================================================================
-- 2026-09-14d  Nightly user_events rollup, scheduled with pg_cron
--
-- APPLIED TO PRODUCTION 2026-09-14.
--
-- WHY pg_cron RATHER THAN A HANDLER + WORKFLOW
--
-- This job is pure SQL. It needs no outbound HTTP, so it needs no pg_net, no
-- Vercel handler, no GitHub workflow and no CRON_SECRET. That also removes a
-- whole class of failure: there is no HTTP status to misparse and no JSON to
-- read, which is exactly how the quote warmer's first run failed (a sed
-- pattern that assumed '"ok":true' with no space, against Python's
-- '"ok": true' with one).
--
-- pg_cron availability was UNVERIFIED when this work was planned — Supabase
-- branching requires the Pro plan, so it could not be tested on a branch.
-- Confirmed here: it installs and schedules fine on this free-tier project.
-- (pg_net egress remains untested, and is no longer needed by anything.)
--
-- WHAT IT IS NOT
--
-- It is NOT a pruning job. Retention is unlimited by decision; nothing in this
-- file deletes anything. The rollup exists so the coach dossier reads a small
-- daily aggregate instead of scanning user_events, which will become the
-- largest table in this database within weeks.
--
-- p_days defaults to 2 rather than 1 so a late or skipped run self-heals on
-- the next night: the ON CONFLICT re-counts the day rather than adding to it,
-- so re-running is idempotent and overlapping windows are harmless.
--
-- Verified end to end before commit: 6 seeded events rolled into 4 aggregate
-- rows with stock_view/IDEA correctly counted as 3.
-- =============================================================================

create extension if not exists pg_cron with schema extensions;

create or replace function public.roll_up_user_events(p_days int default 2)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  insert into public.user_event_rollup (user_id, day, kind, subject, n)
  select e.user_id,
         -- Bucket by IST, not UTC. These are Indian students; a session at
         -- 02:00 IST belongs to the previous trading day in every sense that
         -- matters to the coach.
         (e.occurred_at at time zone 'Asia/Kolkata')::date as day,
         e.kind,
         coalesce(e.subject, '') as subject,
         count(*)
    from public.user_events e
   where e.occurred_at >= now() - make_interval(days => p_days)
   group by 1, 2, 3, 4
  on conflict (user_id, day, kind, subject)
  do update set n = excluded.n;      -- re-count, never accumulate
  get diagnostics n = row_count;
  return n;
end $$;

-- SECURITY DEFINER so it can read every user's events, therefore it must not
-- be callable by anyone who is not the scheduler.
revoke all on function public.roll_up_user_events(int) from anon, authenticated, public;

-- 20:10 UTC = 01:40 IST: after the Indian market day has ended and clear of
-- the other scheduled jobs (universe-refresh 02:30 UTC, data-sync 13:15 UTC,
-- quote warmer 03:00-10:30 UTC).
select cron.schedule(
  'user-events-rollup',
  '10 20 * * *',
  $$select public.roll_up_user_events(2)$$
);
