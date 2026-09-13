-- =============================================================================
-- 2026-09-13k — portfolio_history: signup anchor + mark-to-market daily snapshot
--
-- APPLIED TO PRODUCTION 2026-09-13 14:05 UTC as remote migration
-- `20260913140516_portfolio_history_anchor_and_mtm_snapshot`. This file was
-- written afterwards to close the gap: the migration went in through the
-- Supabase API and never landed in the repo, so `supabase/migrations/` did not
-- describe the live database. Superseded in part by 2026-09-13l (overflow
-- hardening) — that file holds the CURRENT body of admin_portfolio_backfill.
-- Kept for the record of why these objects exist.
--
-- CONTEXT
--
-- The "Value over time" card on #/portfolio showed the "Make your first trade
-- to start charting" placeholder for 100% of users. The primary cause was
-- client-side (js/state.js rebuilt its store from an explicit key allowlist and
-- portfolioHistory was in neither the getState() projection nor
-- applyFullPatch's, so every fetched row was dropped one line after being
-- written). Two data-side problems were found while confirming that:
--
--   1. Every one of the 312 existing rows was source='trade'. The hourly
--      admin_portfolio_backfill cron documented in schema.sql existed in NO
--      scheduler — vercel.json declares no crons and no GitHub workflow called
--      it. A user's series began at their first trade and had one point per
--      trade, nothing else. 8 traders had exactly one row.
--
--   2. admin_portfolio_backfill() did not do what its own docstring claimed.
--      The comment promised "walks every user's transactions and emits daily
--      snapshots"; the body inserted exactly ONE row at now() in both modes.
--
-- WHAT THIS DOES
--
--   * admin_portfolio_backfill(false) seeds a factual ANCHOR point per trading
--     user: their starting cash, timestamped at auth.users.created_at
--     (verified: all 44 traders signed up before their first trade). This is a
--     known-true fact, not a reconstruction — every account opens at
--     starting_cash_paise with no holdings. It gives each series a real left
--     edge instead of starting mid-story at the first trade.
--
--   * admin_portfolio_snapshot_mtm(jsonb) appends one daily_snapshot per
--     trading user, valuing holdings from a price map supplied by the CALLER.
--     Pricing deliberately does NOT read quote_cache: that table is a
--     demand-filled TTL cache, and only 1 of 128 currently-held symbols had a
--     quote fresher than 7 days. Valuing from it would write months-old prices
--     as today's number. /api/admin-snapshot-portfolios fetches live quotes
--     (Dhan -> Yahoo, the same chain the app uses) and passes them in; any
--     symbol it cannot price falls back to cost basis, which is the same
--     approximation the per-trade trigger already makes.
--
--   * Users with zero transactions are skipped on purpose. For them
--     "Make your first trade to start charting" is the correct, honest empty
--     state, and seeding a flat 1L line would be noise.
--
-- WHY MARK-TO-MARKET IS NOT OPTIONAL HERE
--
-- The per-trade trigger values holdings at COST BASIS, which makes a BUY
-- value-neutral — Rs X of cash becomes Rs X of stock — so a buy-and-hold user's
-- entire series is a dead-flat line at their starting cash and cannot express a
-- gain or a loss. 11 of the 42 users with history had exactly that. Cost basis
-- alone carries no information for this chart.
--
-- Both functions are idempotent: the anchor is keyed on source='backfill'
-- (deleted then re-inserted per user) and the daily snapshot is skipped if one
-- already exists for that user today.
--
-- RUN ONCE AFTER APPLYING (this is what was done in production):
--   select public.admin_portfolio_backfill(false);
--   -> {"ok":true,"traders":44,"anchors_written":44,...}
-- =============================================================================

-- NOTE: the body of admin_portfolio_backfill(boolean) shipped by this migration
-- was replaced hours later by 2026-09-13l after it was found to abort on a
-- bigint overflow. Apply 2026-09-13l immediately after this file; it contains
-- the authoritative definition. Only admin_portfolio_snapshot_mtm's original
-- shape is omitted here for the same reason.

-- -----------------------------------------------------------------------------
-- Guard: portfolio_history must already exist (created in schema.sql).
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.portfolio_history') is null then
    raise exception 'public.portfolio_history is missing — apply schema.sql first';
  end if;
end $$;

-- The authoritative bodies for BOTH functions live in
-- 2026-09-13l_portfolio_snapshot_overflow_safe.sql. This migration is retained
-- as the record of intent; applying 13l alone produces the same live state.
