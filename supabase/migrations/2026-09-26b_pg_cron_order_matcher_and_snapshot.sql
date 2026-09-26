-- =============================================================================
-- 2026-09-26b  Order matcher + portfolio snapshot, ticked by pg_cron via pg_net
--
-- WHY
--
-- order-matcher.yml says `*/5 3-10 * * 1-5`, which is 84 ticks per trading day.
-- GitHub actually ran it TWICE a day (measured 2026-09-21..25): once around
-- 08:00 UTC (13:30 IST) and once after 13:00 UTC, when the market is closed and
-- the matcher skips. Every scheduled workflow in this repo also fired ~5 hours
-- late. Median order-to-fill over the prior 14 days: 2,384 minutes.
--
-- pg_cron in this database is punctual: user-events-rollup (2026-09-14d) has
-- run on time every night. So the database schedules the ticks, and pg_net
-- makes the HTTP call to the same Vercel endpoints GitHub calls.
--
-- The GitHub workflows stay as a backstop. Double ticks are safe:
-- _fill_limit_order_core takes the order row FOR UPDATE and raises
-- 'already <status>' for anything no longer pending, which match-orders.py
-- treats as a lost race, not an error.
--
-- SECRET
--
-- The bearer token is the same CRON_SECRET the Vercel env and GitHub hold,
-- stored in Supabase Vault as 'cron_secret' (created out-of-band with
-- vault.create_secret, never committed). It is read per tick from
-- vault.decrypted_secrets, so rotating it is a vault.update_secret, not a
-- migration.
--
-- WHERE TO LOOK WHEN IT BREAKS
--
-- pg_net is fire-and-forget. Responses land in net._http_response (kept ~6h):
--   select id, status_code, left(content, 200), created
--   from net._http_response order by created desc limit 20;
-- and job runs in cron.job_run_details.
-- =============================================================================

create extension if not exists pg_net;

-- Idempotent re-apply: drop our jobs if they exist, then recreate.
do $$
begin
  perform cron.unschedule(jobid) from cron.job
   where jobname in ('order-matcher', 'portfolio-snapshot');
end $$;

-- 03:30-10:30 UTC = 09:00-16:00 IST, Mon-Fri. The handler gates on
-- market_state() itself, so ticks outside the session are cheap no-ops.
select cron.schedule(
  'order-matcher',
  '*/5 3-10 * * 1-5',
  $$
  select net.http_post(
    url := 'https://stocksaathi.co.in/api/match-orders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- 10:30 UTC = 16:00 IST, after the close.
select cron.schedule(
  'portfolio-snapshot',
  '30 10 * * 1-5',
  $$
  select net.http_post(
    url := 'https://stocksaathi.co.in/api/admin-snapshot-portfolios',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
