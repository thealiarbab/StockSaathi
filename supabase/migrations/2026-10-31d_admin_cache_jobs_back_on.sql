-- Admin dashboard cache jobs back on (31 Oct 2026).
--
-- behaviour-cache, signup-funnel-cache and signup-stats-cache were switched
-- off around 25-28 Oct: the 7-day behaviour pass took 469 s (25 Oct 19:10
-- IST), other jobs hit "job startup timeout" and the order matcher could not
-- start. Since the web_events trim (2026-10-25c, raw rows kept 3 days) the
-- same work measures: behaviour 1 day 10 s, 7 days 22 s; funnel 7 days 2.5 s;
-- signup stats 18 s. The 30/90-day behaviour passes still run only 2-6 am IST.
-- Tighter statement timeouts so a slow run is cancelled instead of holding
-- the database: behaviour 5 min (was 15), funnel 2 min (was 5), stats 60 s.
-- Applied with cron.alter_job on jobs 11, 12, 13.

select cron.alter_job(11, command := $$set statement_timeout = '5min'; select public.refresh_admin_behaviour();$$, active := true);
select cron.alter_job(12, command := $$set statement_timeout = '2min'; select public.refresh_admin_funnel();$$, active := true);
select cron.alter_job(13, command := $$set statement_timeout = '60s'; select public.refresh_admin_signup_stats();$$, active := true);
