-- Orders are filled by the server only.
--
-- /api/match-orders (pg_cron every minute of market hours, GitHub Actions as
-- backup) fills every order through admin_fill_limit_order. The browser used
-- to run its own matcher every 12 s and call fill_limit_order with the user's
-- session; that loop is gone (js/features/limitOrders.js now only listens for
-- the server's fills over Realtime). Take the browser's ability to fill away
-- too, so execution can never again depend on a tab being open.
--
-- The core already ignored the browser's price (it reads quote_cache itself),
-- so this closes a path that was redundant, not one that was exploitable.

revoke all on function public.fill_limit_order(uuid, bigint) from public, anon, authenticated;
grant execute on function public.fill_limit_order(uuid, bigint) to service_role;
