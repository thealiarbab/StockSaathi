-- =============================================================================
-- 2026-09-14b  Correct the future-dated fills left by the 2026-09-13 backfill
--
-- APPLIED TO PRODUCTION 2026-09-14. Recorded here because this repo has been
-- bitten before by migrations that existed only in the database (see the
-- 2026-09-13k/13l backfill and its commit message): a checkout rebuilt from
-- the repo would otherwise silently lack this correction.
--
-- WHAT WAS WRONG
--
-- The order backfill ran at 2026-09-13 12:34:41 and stamped filled_at /
-- created_at with the NEXT MARKET OPEN instead of the moment the fill was
-- applied. Eight orders and their eight transactions therefore carried
-- 2026-09-15 03:45:00 — roughly two days in the future — while `now()` was
-- 2026-09-14 08:44.
--
-- WHY IT MATTERS RATHER THAN BEING COSMETIC
--
-- transactions.created_at orders trade history and the realised-P&L walk in
-- js/coach/agent.js, and the coach dossier is about to read both. A trade
-- dated in the future sorts first forever, so "your last trade" and "your best
-- trade" would both have been answered from a row that had not happened yet.
-- For users who cannot check the answer, that is the expensive kind of wrong.
--
-- SCOPE, VERIFIED BEFORE WRITING
--
--   8 transactions with created_at > now()
--   8 limit_orders with filled_at > now()
--   2 users affected
--   8/8 joinable to an order_backfill_audit row (so: provably backfill rows,
--     not live matcher output)
--   0 portfolio_history rows with a future ts
--
-- REVERSIBILITY
--
-- The prior value is appended to order_backfill_audit.detail for each affected
-- order before the update, so this can be undone without archaeology.
-- =============================================================================

update public.order_backfill_audit a
   set detail = coalesce(a.detail, '')
              || ' | 2026-09-14 corrected future-dated fill: was '
              || (select lo.filled_at::text from public.limit_orders lo where lo.id = a.order_id)
              || ' -> ' || a.ran_at::text
 where exists (
   select 1 from public.limit_orders lo
    where lo.id = a.order_id and lo.filled_at > now()
 );

update public.transactions t
   set created_at = a.ran_at
  from public.limit_orders lo
  join public.order_backfill_audit a on a.order_id = lo.id
 where lo.filled_txn_id = t.id
   and t.created_at > now();

update public.limit_orders lo
   set filled_at = a.ran_at
  from public.order_backfill_audit a
 where a.order_id = lo.id
   and lo.filled_at > now();

-- Verified after: future_txns 0, future_fills 0, all 8 transactions now at
-- a.ran_at, 8 audit notes written, newest fill and newest txn both
-- 2026-09-13 12:34:41 (i.e. in the past).
