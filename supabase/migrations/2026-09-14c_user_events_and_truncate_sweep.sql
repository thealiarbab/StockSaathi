-- =============================================================================
-- 2026-09-14c  user_events telemetry + a TRUNCATE sweep across public tables
--
-- APPLIED TO PRODUCTION 2026-09-14 in three steps (create, then two grant
-- corrections). Consolidated here as one file because a fresh checkout should
-- end in the final state, not replay the mistake in the middle of it.
--
-- PART 1 — user_events / user_event_rollup
--
-- No behavioural telemetry existed anywhere in this app: no table, no helper,
-- no call site. The coach had no idea what a user did between trades.
--
-- Retention is UNLIMITED by decision. There is deliberately no pruning job.
-- user_event_rollup exists so the dossier reads a small daily aggregate as the
-- raw table grows — it is a read optimisation, NOT a precursor to deletion.
--
-- PART 2 — the TRUNCATE sweep, which is the part worth reading
--
-- Writing Part 1 reproduced a defect this repo has already recorded once.
-- The migration contained an explicit
--
--     revoke all on public.user_events from anon, public;
--
-- and it did not work, because `authenticated` is neither `anon` nor `public`:
-- it holds its OWN grant from Supabase's default privileges, applied at CREATE
-- TABLE time. Verified immediately after creating the table, `authenticated`
-- still had SELECT/INSERT/UPDATE/DELETE/TRUNCATE.
--
-- TRUNCATE is the one that matters because POSTGRES RLS DOES NOT GOVERN IT.
-- Every policy can be perfect and the grant still permits emptying the whole
-- table for every user.
--
-- Auditing the rest of the schema then found five pre-existing tables in the
-- same state, for BOTH anon and authenticated:
--
--     profiles          124 rows   every user's identity
--     coach_messages  1,095 rows   every coach conversation
--     watchlist, friends, ai_response_cache
--
-- 2026-09-13g fixed exactly this for admin_audit_log and AGENTS.md §2.9 warns
-- about it; the fix was never swept across the other tables.
--
-- Mitigating, and stated so the severity is not overclaimed: PostgREST exposes
-- no TRUNCATE verb, so this was not reachable through the REST API on its own.
-- The grant should still not exist.
--
-- anon additionally loses DML on the four user-scoped tables. It has no policy
-- on any of them, so its writes already matched zero rows — this removes a
-- grant that was never usable rather than changing behaviour. ai_response_cache
-- keeps anon SELECT because it has a public-read policy the app relies on.
--
-- Verified after: TRUNCATE false for anon and authenticated on all six tables;
-- and a smoke test as a real user confirmed coach_messages insert, watchlist
-- insert+delete, user_events insert and profiles update all still succeed.
-- =============================================================================

-- ── Part 1: tables ──────────────────────────────────────────────────────────

create table if not exists public.user_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null,
  subject     text,
  props       jsonb not null default '{}'::jsonb,
  -- CLIENT clock. Events are batched, so insert time lags the real moment by
  -- up to ~15s; created_at keeps the server's own view for sanity checks.
  occurred_at timestamptz not null,
  created_at  timestamptz not null default now(),
  -- kind is CONSTRAINED on purpose. An unconstrained free-text kind becomes a
  -- garbage dump within a month and the rollup stops meaning anything.
  constraint user_events_kind_check check (kind in (
    'page_view','stock_view','news_click','news_open','chart_range',
    'chart_interact','search','market_browse','watchlist_add',
    'watchlist_remove','coach_open','order_ticket_open','tab_focus'))
);

create index if not exists idx_user_events_user_time
  on public.user_events (user_id, occurred_at desc);
create index if not exists idx_user_events_user_kind_time
  on public.user_events (user_id, kind, occurred_at desc);

alter table public.user_events enable row level security;

create table if not exists public.user_event_rollup (
  user_id uuid  not null references auth.users(id) on delete cascade,
  day     date  not null,
  kind    text  not null,
  subject text  not null default '',
  n       int   not null default 0,
  primary key (user_id, day, kind, subject)
);

create index if not exists idx_user_event_rollup_user_day
  on public.user_event_rollup (user_id, day desc);

alter table public.user_event_rollup enable row level security;

-- ── Part 1b: policies ───────────────────────────────────────────────────────
-- (select auth.uid()), not auth.uid(). On user_events it genuinely matters:
-- the bare form is volatile and cannot always fold into an index condition,
-- and this will be the largest table in the database within weeks.

drop policy if exists user_events_self_insert on public.user_events;
create policy user_events_self_insert on public.user_events
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists user_events_self_read on public.user_events;
create policy user_events_self_read on public.user_events
  for select to authenticated using ((select auth.uid()) = user_id);
-- Deliberately NO update or delete policy. Telemetry is append-only to its
-- owner; maintenance runs as service_role.

drop policy if exists user_event_rollup_self_read on public.user_event_rollup;
create policy user_event_rollup_self_read on public.user_event_rollup
  for select to authenticated using ((select auth.uid()) = user_id);

-- ── Part 2: grants, stated against the ROLE and not against `public` ────────

revoke all on public.user_events       from anon, public, authenticated;
revoke all on public.user_event_rollup from anon, public, authenticated;

grant select, insert on public.user_events       to authenticated;
grant select         on public.user_event_rollup to authenticated;
-- The identity sequence must stay usable or every insert fails on nextval.
grant usage, select on all sequences in schema public to authenticated;

-- ── Part 2b: the sweep across pre-existing tables ──────────────────────────

revoke truncate on public.profiles, public.coach_messages, public.watchlist,
                   public.friends, public.ai_response_cache
  from anon, authenticated;

revoke insert, update, delete on public.profiles, public.coach_messages,
                                 public.watchlist, public.friends
  from anon;

revoke insert, update, delete on public.ai_response_cache from anon, authenticated;

comment on table public.user_events is
  'Append-only behavioural telemetry, RLS-scoped to its owner. Unlimited retention by decision (2026-09-14): no pruning job exists and user_event_rollup is a read optimisation, not a precursor to deletion.';
