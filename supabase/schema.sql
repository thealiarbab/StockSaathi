-- =============================================================================
-- StockSaathi — Postgres baseline for Supabase.
--
-- ⚠ DO NOT RE-RUN THIS AGAINST AN EXISTING DATABASE. It is no longer
--   idempotent in any safe sense. It is a BASELINE that has been superseded by
--   supabase/migrations/, and re-running it would SILENTLY REINTRODUCE CLOSED
--   SECURITY HOLES, because `create or replace` overwrites the fixed versions:
--
--     • `apply_trade` below is the PRE-2026-09-12b body that takes the
--       execution price from the client. Re-running it restores "buy RELIANCE
--       at ₹0.01, sell at market".
--     • `fill_limit_order` below is likewise pre-12b.
--     • the `*_self_all` policies below are `for all`, which 2026-09-13e
--       replaced with read-only policies after they were found to let a
--       logged-in client POST holdings and cash straight to PostgREST.
--
--   For a NEW project: run this first, then every file in
--   supabase/migrations/ in filename order.
--   For the EXISTING project: use migrations only.
--
--   The function bodies here are deliberately left at their original state so
--   the migration history reads correctly. The policies below have been
--   corrected in place, because a stale policy is far likelier to be
--   copy-pasted than a stale function body.
-- =============================================================================

create extension if not exists pgcrypto;

-- --------------------------------------------------------------------------
-- profiles  (extends auth.users with app-specific fields)
-- --------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text unique not null,
  display_name  text not null,
  email         text not null,
  age           int check (age is null or (age >= 13 and age <= 120)),
  school        text,
  class_code    text,
  city          text,
  risk_profile  text check (risk_profile is null or risk_profile in ('cautious','balanced','bold')),
  parent_email  text,
  parent_consent_at timestamptz,
  avatar_color  text default 'green',
  onboarded     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_profiles_username on public.profiles (lower(username));
create index if not exists idx_profiles_school   on public.profiles (lower(school));

-- --------------------------------------------------------------------------
-- portfolios  (1:1 with user)
-- --------------------------------------------------------------------------
create table if not exists public.portfolios (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  cash_paise           bigint not null default 10000000,
  starting_cash_paise  bigint not null default 10000000,
  updated_at           timestamptz not null default now()
);

-- --------------------------------------------------------------------------
-- holdings
-- --------------------------------------------------------------------------
create table if not exists public.holdings (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  symbol          text not null,
  qty             numeric(18,6) not null check (qty > 0),
  avg_cost_paise  bigint not null check (avg_cost_paise >= 0),
  first_bought_at timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, symbol)
);
create index if not exists idx_holdings_user on public.holdings (user_id);

-- --------------------------------------------------------------------------
-- transactions
-- --------------------------------------------------------------------------
create table if not exists public.transactions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  symbol           text not null,
  side             text not null check (side in ('BUY','SELL')),
  qty              numeric(18,6) not null check (qty > 0),
  price_paise      bigint not null check (price_paise >= 0),
  value_paise      bigint not null check (value_paise >= 0),
  bias_flags       jsonb default '[]'::jsonb,
  idempotency_key  text,
  created_at       timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create index if not exists idx_txn_user_time on public.transactions (user_id, created_at desc);

-- --------------------------------------------------------------------------
-- friends
-- --------------------------------------------------------------------------
create table if not exists public.friends (
  user_id    uuid not null references auth.users(id) on delete cascade,
  friend_id  uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);
create index if not exists idx_friends_friend on public.friends (friend_id);

-- --------------------------------------------------------------------------
-- transfers
-- --------------------------------------------------------------------------
create table if not exists public.transfers (
  id            uuid primary key default gen_random_uuid(),
  sender_id     uuid not null references auth.users(id) on delete cascade,
  recipient_id  uuid references auth.users(id) on delete cascade,
  code          text unique,
  amount_paise  bigint not null check (amount_paise > 0),
  note          text,
  status        text not null default 'pending' check (status in ('pending','completed','cancelled')),
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index if not exists idx_transfers_sender    on public.transfers (sender_id, created_at desc);
create index if not exists idx_transfers_recipient on public.transfers (recipient_id, created_at desc);
create index if not exists idx_transfers_code      on public.transfers (code) where code is not null;

-- --------------------------------------------------------------------------
-- coach_messages
-- --------------------------------------------------------------------------
create table if not exists public.coach_messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  event_type      text not null,
  trigger_symbol  text,
  payload         jsonb not null,
  model           text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_coach_user_time on public.coach_messages (user_id, created_at desc);

-- --------------------------------------------------------------------------
-- watchlist
-- --------------------------------------------------------------------------
create table if not exists public.watchlist (
  user_id   uuid not null references auth.users(id) on delete cascade,
  symbol    text not null,
  added_at  timestamptz not null default now(),
  primary key (user_id, symbol)
);

-- --------------------------------------------------------------------------
-- limit_orders
--   Pending BUY/SELL orders that execute when market price crosses the limit.
--   For BUY: fires when market <= limit_price. For SELL: market >= limit_price.
--   Cash is reserved on BUY orders (subtracted up front, refunded if cancelled).
-- --------------------------------------------------------------------------
create table if not exists public.limit_orders (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  symbol             text not null,
  side               text not null check (side in ('BUY','SELL')),
  qty                numeric(18,6) not null check (qty > 0),
  limit_price_paise  bigint not null check (limit_price_paise > 0),
  reserved_cash      bigint not null default 0,
  status             text not null default 'pending' check (status in ('pending','filled','cancelled')),
  filled_at          timestamptz,
  filled_price_paise bigint,
  filled_txn_id      uuid references public.transactions(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists idx_orders_pending on public.limit_orders (status, symbol) where status = 'pending';
create index if not exists idx_orders_user on public.limit_orders (user_id, created_at desc);

-- =============================================================================
-- ATOMIC RPC: apply_trade
-- Immediate market-order execution. Cash debit + holding upsert, idempotent.
-- Uses scalar variables only (no composite types) to avoid Supabase quirks.
-- =============================================================================
create or replace function public.apply_trade(
  p_symbol          text,
  p_side            text,
  p_qty             numeric,
  p_price_paise     bigint,
  p_idempotency_key text,
  p_bias_flags      jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id      uuid := auth.uid();
  v_value        bigint := round(p_qty * p_price_paise)::bigint;
  v_existing_id  uuid;
  v_holding_id   uuid;
  v_holding_qty  numeric(18,6);
  v_holding_avg  bigint;
  v_new_qty      numeric(18,6);
  v_new_avg      bigint;
  v_txn_id       uuid;
begin
  if v_user_id is null then raise exception 'not logged in'; end if;
  if p_side not in ('BUY','SELL') then raise exception 'invalid side: %', p_side; end if;
  if p_qty <= 0 then raise exception 'qty must be positive'; end if;

  -- Idempotency shortcut
  if p_idempotency_key is not null then
    select id into v_existing_id
      from public.transactions
      where user_id = v_user_id and idempotency_key = p_idempotency_key
      limit 1;
    if v_existing_id is not null then
      return jsonb_build_object('ok', true, 'txn_id', v_existing_id, 'idempotent', true);
    end if;
  end if;

  perform 1 from public.portfolios where user_id = v_user_id for update;

  if p_side = 'BUY' then
    update public.portfolios
      set cash_paise = cash_paise - v_value, updated_at = now()
      where user_id = v_user_id and cash_paise >= v_value;
    if not found then raise exception 'insufficient cash'; end if;

    select id, qty, avg_cost_paise
      into v_holding_id, v_holding_qty, v_holding_avg
      from public.holdings
      where user_id = v_user_id and symbol = p_symbol
      for update;

    if v_holding_id is not null then
      v_new_qty := v_holding_qty + p_qty;
      v_new_avg := round(((v_holding_avg::numeric * v_holding_qty) + v_value) / v_new_qty)::bigint;
      update public.holdings set qty = v_new_qty, avg_cost_paise = v_new_avg, updated_at = now()
        where id = v_holding_id;
    else
      insert into public.holdings (user_id, symbol, qty, avg_cost_paise)
        values (v_user_id, p_symbol, p_qty, p_price_paise);
    end if;
  else
    select id, qty
      into v_holding_id, v_holding_qty
      from public.holdings
      where user_id = v_user_id and symbol = p_symbol
      for update;

    if v_holding_id is null or v_holding_qty < p_qty then
      raise exception 'insufficient holding';
    end if;
    v_new_qty := v_holding_qty - p_qty;
    if v_new_qty <= 1e-9 then
      delete from public.holdings where id = v_holding_id;
    else
      update public.holdings set qty = v_new_qty, updated_at = now() where id = v_holding_id;
    end if;
    update public.portfolios set cash_paise = cash_paise + v_value, updated_at = now()
      where user_id = v_user_id;
  end if;

  insert into public.transactions (user_id, symbol, side, qty, price_paise, value_paise, bias_flags, idempotency_key)
    values (v_user_id, p_symbol, p_side, p_qty, p_price_paise, v_value, p_bias_flags, p_idempotency_key)
    returning id into v_txn_id;

  return jsonb_build_object('ok', true, 'txn_id', v_txn_id);
end;
$$;

grant execute on function public.apply_trade(text, text, numeric, bigint, text, jsonb) to authenticated;

-- =============================================================================
-- ATOMIC RPC: apply_transfer (P2P virtual cash)
-- =============================================================================
-- Add idempotency + cap to apply_transfer. An idempotency_key stops the client
-- from double-spending under network retry; the cap rejects absurd values
-- early so errors are visibly bad, not silently huge.
create or replace function public.apply_transfer(
  p_recipient_username text,
  p_amount_paise       bigint,
  p_note               text,
  p_idempotency_key    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender_id    uuid := auth.uid();
  v_recipient_id uuid;
  v_transfer_id  uuid;
  v_max_paise    bigint := 100000000000; -- ₹100 cr cap, well above any legit sim transfer
  v_existing_id  uuid;
begin
  if v_sender_id is null then raise exception 'not logged in'; end if;
  if p_amount_paise <= 0 then raise exception 'amount must be positive'; end if;
  if p_amount_paise > v_max_paise then raise exception 'amount exceeds cap'; end if;
  -- Cap note length so UIs cannot render unbounded payloads.
  p_note := substr(coalesce(p_note, ''), 1, 280);

  if p_idempotency_key is not null and length(p_idempotency_key) > 0 then
    select id into v_existing_id
      from public.transfers
      where sender_id = v_sender_id and code = p_idempotency_key
      limit 1;
    if v_existing_id is not null then
      return jsonb_build_object('ok', true, 'transfer_id', v_existing_id, 'idempotent', true);
    end if;
  end if;

  select id into v_recipient_id from public.profiles
    where lower(username) = lower(trim(p_recipient_username))
    limit 1;
  if v_recipient_id is null then raise exception 'recipient not found'; end if;
  if v_recipient_id = v_sender_id then raise exception 'cannot send to self'; end if;

  update public.portfolios set cash_paise = cash_paise - p_amount_paise, updated_at = now()
    where user_id = v_sender_id and cash_paise >= p_amount_paise;
  if not found then raise exception 'insufficient cash'; end if;

  insert into public.portfolios (user_id, cash_paise) values (v_recipient_id, p_amount_paise)
    on conflict (user_id) do update set
      cash_paise = public.portfolios.cash_paise + excluded.cash_paise,
      updated_at = now();

  insert into public.transfers (sender_id, recipient_id, amount_paise, note, status, completed_at, code)
    values (v_sender_id, v_recipient_id, p_amount_paise, p_note, 'completed', now(),
            p_idempotency_key)
    returning id into v_transfer_id;

  return jsonb_build_object('ok', true, 'transfer_id', v_transfer_id);
end;
$$;

grant execute on function public.apply_transfer(text, bigint, text, text) to authenticated;
-- Back-compat: old 3-arg signature still callable for already-deployed clients.
grant execute on function public.apply_transfer(text, bigint, text) to authenticated;

-- =============================================================================
-- ATOMIC RPC: create_transfer_code + redeem_transfer_code
-- Server-authoritative transfer codes. Removes the old client behaviour of
-- iterating every ss.userstate.* localStorage key on the device (cross-user
-- privacy leak + pending-code redeem theft).
-- =============================================================================
create or replace function public.create_transfer_code(
  p_amount_paise bigint,
  p_note         text,
  p_code         text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender_id   uuid := auth.uid();
  v_transfer_id uuid;
  v_clean_code  text;
begin
  if v_sender_id is null then raise exception 'not logged in'; end if;
  if p_amount_paise <= 0 then raise exception 'amount must be positive'; end if;
  if p_amount_paise > 100000000000 then raise exception 'amount exceeds cap'; end if;
  v_clean_code := upper(regexp_replace(coalesce(p_code, ''), '[^A-Z0-9-]', '', 'g'));
  if length(v_clean_code) < 6 or length(v_clean_code) > 12 then
    raise exception 'bad code';
  end if;

  update public.portfolios
    set cash_paise = cash_paise - p_amount_paise, updated_at = now()
    where user_id = v_sender_id and cash_paise >= p_amount_paise;
  if not found then raise exception 'insufficient cash'; end if;

  insert into public.transfers (sender_id, recipient_id, code, amount_paise,
                                note, status)
    values (v_sender_id, null, v_clean_code, p_amount_paise,
            substr(coalesce(p_note, ''), 1, 280), 'pending')
    returning id into v_transfer_id;

  return jsonb_build_object('ok', true, 'transfer_id', v_transfer_id,
                            'code', v_clean_code);
exception
  when unique_violation then
    -- Refund on dup-code race
    update public.portfolios set cash_paise = cash_paise + p_amount_paise, updated_at = now()
      where user_id = v_sender_id;
    raise exception 'code already in use';
end;
$$;
grant execute on function public.create_transfer_code(bigint, text, text) to authenticated;

create or replace function public.redeem_transfer_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id     uuid := auth.uid();
  v_transfer_id uuid;
  v_sender_id   uuid;
  v_amount      bigint;
  v_clean       text;
begin
  if v_user_id is null then raise exception 'not logged in'; end if;
  v_clean := upper(regexp_replace(coalesce(p_code, ''), '[^A-Z0-9-]', '', 'g'));
  if length(v_clean) < 6 then raise exception 'bad code'; end if;

  select id, sender_id, amount_paise
    into v_transfer_id, v_sender_id, v_amount
    from public.transfers
    where code = v_clean and status = 'pending'
    for update;
  if not found then raise exception 'code not found or already redeemed'; end if;
  if v_sender_id = v_user_id then raise exception 'cannot redeem your own code'; end if;

  update public.transfers
    set status = 'completed', recipient_id = v_user_id, completed_at = now()
    where id = v_transfer_id;

  insert into public.portfolios (user_id, cash_paise) values (v_user_id, v_amount)
    on conflict (user_id) do update set
      cash_paise = public.portfolios.cash_paise + excluded.cash_paise,
      updated_at = now();

  return jsonb_build_object('ok', true, 'transfer_id', v_transfer_id,
                            'amount_paise', v_amount);
end;
$$;
grant execute on function public.redeem_transfer_code(text) to authenticated;

-- =============================================================================
-- ATOMIC RPC: reset_my_portfolio
-- Server-side version of the "Reset portfolio" settings button. Clears
-- holdings, transactions, transfers (both sides), coach_messages, watchlist,
-- and limit_orders for the caller. Cash is restored to the original starting
-- amount. Profile, friends, and account are preserved.
-- =============================================================================
create or replace function public.reset_my_portfolio()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_start   bigint;
begin
  if v_user_id is null then raise exception 'not logged in'; end if;

  select starting_cash_paise into v_start
    from public.portfolios where user_id = v_user_id;
  if v_start is null then v_start := 10000000; end if;  -- ₹1,00,000 default

  update public.portfolios
    set cash_paise = v_start, updated_at = now()
    where user_id = v_user_id;

  delete from public.holdings      where user_id = v_user_id;
  delete from public.transactions  where user_id = v_user_id;
  delete from public.coach_messages where user_id = v_user_id;
  delete from public.watchlist     where user_id = v_user_id;
  delete from public.limit_orders  where user_id = v_user_id;
  -- Only delete transfers where THIS user is the sender. Cancelled pending
  -- codes get refunded via the code's sender side.
  delete from public.transfers where sender_id = v_user_id;

  return jsonb_build_object('ok', true, 'cash_paise', v_start);
end;
$$;
grant execute on function public.reset_my_portfolio() to authenticated;

-- =============================================================================
-- Friend + transfer-history RPCs (bypass the tightened profiles RLS so the
-- Friends page can render other users' display names without opening profiles
-- for bulk anon reads).
-- =============================================================================

-- Returns the caller's friend list enriched with public profile fields.
-- Ordered by most-recently added so the UI mirrors Supabase's realtime feed.
create or replace function public.list_my_friends()
returns table (
  friend_id uuid,
  username text,
  display_name text,
  avatar_color text,
  school text,
  added_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null then return; end if;
  return query
    select p.id, p.username, p.display_name, p.avatar_color, p.school, f.created_at
    from public.friends f
    join public.profiles p on p.id = f.friend_id
    where f.user_id = v_user_id
    order by f.created_at desc;
end;
$$;
grant execute on function public.list_my_friends() to authenticated;

-- Atomic "resolve username → insert friends row → return profile". Replaces
-- the old two-step client flow that needed anon SELECT on profiles.
create or replace function public.add_friend_by_username(p_username text)
returns table (
  friend_id uuid,
  username text,
  display_name text,
  avatar_color text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id   uuid := auth.uid();
  v_friend_id uuid;
  v_clean     text := lower(trim(coalesce(p_username, '')));
begin
  if v_user_id is null then raise exception 'not logged in'; end if;
  if length(v_clean) < 2 then raise exception 'username too short'; end if;

  select id into v_friend_id from public.profiles
    where lower(username) = v_clean
    limit 1;
  if v_friend_id is null then raise exception 'recipient not found'; end if;
  if v_friend_id = v_user_id then raise exception 'cannot add yourself'; end if;

  insert into public.friends (user_id, friend_id)
    values (v_user_id, v_friend_id)
    on conflict do nothing;

  return query
    select p.id, p.username, p.display_name, p.avatar_color
    from public.profiles p where p.id = v_friend_id;
end;
$$;
grant execute on function public.add_friend_by_username(text) to authenticated;

-- Returns the caller's transfers with the counterparty's username + display
-- name resolved server-side. Without this, history shows "—" for every row
-- because anon clients can't read other users' profile rows.
create or replace function public.list_my_transfers(p_limit int default 100)
returns table (
  id uuid,
  direction text,
  counterparty_id uuid,
  counterparty_username text,
  counterparty_display_name text,
  counterparty_avatar_color text,
  amount_paise bigint,
  note text,
  status text,
  code text,
  created_at timestamptz,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null then return; end if;
  return query
    select
      t.id,
      case when t.sender_id = v_user_id then 'out' else 'in' end,
      case when t.sender_id = v_user_id then t.recipient_id else t.sender_id end,
      cp.username,
      cp.display_name,
      cp.avatar_color,
      t.amount_paise,
      t.note,
      t.status,
      case when t.sender_id = v_user_id then t.code else null end,
      t.created_at,
      t.completed_at
    from public.transfers t
    left join public.profiles cp on cp.id = case
      when t.sender_id = v_user_id then t.recipient_id
      else t.sender_id
    end
    where t.sender_id = v_user_id or t.recipient_id = v_user_id
    order by t.created_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;
grant execute on function public.list_my_transfers(int) to authenticated;

-- =============================================================================
-- ATOMIC RPC: place_limit_order
-- Reserves cash for BUY orders. SELL orders reserve the qty (validated at fill).
-- =============================================================================
create or replace function public.place_limit_order(
  p_symbol            text,
  p_side              text,
  p_qty               numeric,
  p_limit_price_paise bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id      uuid := auth.uid();
  v_reserve      bigint := round(p_qty * p_limit_price_paise)::bigint;
  v_holding_qty  numeric(18,6);
  v_order_id     uuid;
begin
  if v_user_id is null then raise exception 'not logged in'; end if;
  if p_side not in ('BUY','SELL') then raise exception 'invalid side'; end if;
  if p_qty <= 0 or p_limit_price_paise <= 0 then raise exception 'qty and price must be positive'; end if;

  if p_side = 'BUY' then
    update public.portfolios set cash_paise = cash_paise - v_reserve, updated_at = now()
      where user_id = v_user_id and cash_paise >= v_reserve;
    if not found then raise exception 'insufficient cash'; end if;
  else
    select qty into v_holding_qty from public.holdings
      where user_id = v_user_id and symbol = p_symbol;
    if v_holding_qty is null or v_holding_qty < p_qty then
      raise exception 'insufficient holding';
    end if;
    -- NOTE: we don't lock the shares; multi-order users can oversell. For
    -- the pitch scale this is acceptable. Future: add reservation column.
  end if;

  insert into public.limit_orders (user_id, symbol, side, qty, limit_price_paise, reserved_cash)
    values (v_user_id, p_symbol, p_side, p_qty, p_limit_price_paise,
            case when p_side = 'BUY' then v_reserve else 0 end)
    returning id into v_order_id;

  return jsonb_build_object('ok', true, 'order_id', v_order_id);
end;
$$;

grant execute on function public.place_limit_order(text, text, numeric, bigint) to authenticated;

-- =============================================================================
-- ATOMIC RPC: cancel_limit_order
-- =============================================================================
create or replace function public.cancel_limit_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id   uuid := auth.uid();
  v_order_side   text;
  v_reserve      bigint;
  v_status       text;
begin
  if v_user_id is null then raise exception 'not logged in'; end if;
  select side, reserved_cash, status
    into v_order_side, v_reserve, v_status
    from public.limit_orders
    where id = p_order_id and user_id = v_user_id
    for update;
  if not found then raise exception 'order not found'; end if;
  if v_status <> 'pending' then raise exception 'order already %', v_status; end if;

  update public.limit_orders set status = 'cancelled' where id = p_order_id;
  if v_order_side = 'BUY' and v_reserve > 0 then
    update public.portfolios set cash_paise = cash_paise + v_reserve, updated_at = now()
      where user_id = v_user_id;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.cancel_limit_order(uuid) to authenticated;

-- =============================================================================
-- ATOMIC RPC: fill_limit_order
-- Called by the client matcher when live price crosses the limit.
-- Converts the pending order into a transaction + holding update,
-- returning the BUY cash reservation if fill price < limit.
-- =============================================================================
create or replace function public.fill_limit_order(
  p_order_id      uuid,
  p_market_paise  bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id       uuid := auth.uid();
  v_order_symbol  text;
  v_order_side    text;
  v_order_qty     numeric(18,6);
  v_limit_price   bigint;
  v_reserve       bigint;
  v_status        text;
  v_fill_price    bigint;
  v_fill_value    bigint;
  v_refund        bigint := 0;
  v_extra         bigint := 0;
  v_holding_id    uuid;
  v_holding_qty   numeric(18,6);
  v_holding_avg   bigint;
  v_new_qty       numeric(18,6);
  v_new_avg       bigint;
  v_txn_id        uuid;
begin
  if v_user_id is null then raise exception 'not logged in'; end if;

  select symbol, side, qty, limit_price_paise, reserved_cash, status
    into v_order_symbol, v_order_side, v_order_qty, v_limit_price, v_reserve, v_status
    from public.limit_orders
    where id = p_order_id and user_id = v_user_id
    for update;
  if not found then raise exception 'order not found'; end if;
  if v_status <> 'pending' then raise exception 'already %', v_status; end if;

  -- Validate the fill condition: market price must have crossed the limit
  if v_order_side = 'BUY' and p_market_paise > v_limit_price then
    raise exception 'market has not crossed limit (buy)';
  end if;
  if v_order_side = 'SELL' and p_market_paise < v_limit_price then
    raise exception 'market has not crossed limit (sell)';
  end if;

  -- Fill at the better of limit or market (price improvement for the user)
  if v_order_side = 'BUY' then
    v_fill_price := least(v_limit_price, p_market_paise);
  else
    v_fill_price := greatest(v_limit_price, p_market_paise);
  end if;
  v_fill_value := round(v_order_qty * v_fill_price)::bigint;

  perform 1 from public.portfolios where user_id = v_user_id for update;

  if v_order_side = 'BUY' then
    -- Refund any unused reserve (limit - fill) * qty
    v_refund := v_reserve - v_fill_value;
    if v_refund > 0 then
      update public.portfolios set cash_paise = cash_paise + v_refund, updated_at = now()
        where user_id = v_user_id;
    elsif v_refund < 0 then
      -- Shouldn't happen but guard
      raise exception 'reservation underflow';
    end if;

    select id, qty, avg_cost_paise
      into v_holding_id, v_holding_qty, v_holding_avg
      from public.holdings
      where user_id = v_user_id and symbol = v_order_symbol
      for update;
    if v_holding_id is not null then
      v_new_qty := v_holding_qty + v_order_qty;
      v_new_avg := round(((v_holding_avg::numeric * v_holding_qty) + v_fill_value) / v_new_qty)::bigint;
      update public.holdings set qty = v_new_qty, avg_cost_paise = v_new_avg, updated_at = now()
        where id = v_holding_id;
    else
      insert into public.holdings (user_id, symbol, qty, avg_cost_paise)
        values (v_user_id, v_order_symbol, v_order_qty, v_fill_price);
    end if;
  else
    -- SELL: verify holding still has enough qty
    select id, qty into v_holding_id, v_holding_qty
      from public.holdings
      where user_id = v_user_id and symbol = v_order_symbol
      for update;
    if v_holding_id is null or v_holding_qty < v_order_qty then
      raise exception 'insufficient holding at fill time';
    end if;
    v_new_qty := v_holding_qty - v_order_qty;
    if v_new_qty <= 1e-9 then
      delete from public.holdings where id = v_holding_id;
    else
      update public.holdings set qty = v_new_qty, updated_at = now() where id = v_holding_id;
    end if;
    update public.portfolios set cash_paise = cash_paise + v_fill_value, updated_at = now()
      where user_id = v_user_id;
  end if;

  insert into public.transactions (user_id, symbol, side, qty, price_paise, value_paise, bias_flags, idempotency_key)
    values (v_user_id, v_order_symbol, v_order_side, v_order_qty, v_fill_price, v_fill_value,
            jsonb_build_array(jsonb_build_object('bias','limit_order_filled','order_id',p_order_id)),
            'limit_' || p_order_id::text)
    returning id into v_txn_id;

  update public.limit_orders
    set status = 'filled', filled_at = now(),
        filled_price_paise = v_fill_price, filled_txn_id = v_txn_id
    where id = p_order_id;

  return jsonb_build_object('ok', true, 'fill_price', v_fill_price, 'txn_id', v_txn_id);
end;
$$;

grant execute on function public.fill_limit_order(uuid, bigint) to authenticated;

-- =============================================================================
-- Bootstrap trigger: create profile + portfolio on signup
-- =============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username      text := coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1));
  v_display_name  text := coalesce(new.raw_user_meta_data->>'display_name', v_username);
  v_avatar        text := coalesce(new.raw_user_meta_data->>'avatar_color', 'green');
  v_username_u    text := v_username;
  v_try           int := 0;
begin
  while exists (select 1 from public.profiles where lower(username) = lower(v_username_u)) loop
    v_try := v_try + 1;
    v_username_u := v_username || v_try::text;
    exit when v_try > 999;
  end loop;

  insert into public.profiles (id, username, display_name, email, avatar_color)
    values (new.id, v_username_u, v_display_name, new.email, v_avatar);
  insert into public.portfolios (user_id) values (new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- Leaderboard removed Apr 24 2026. The function + view are intentionally
-- not declared here. If you're applying this schema to an existing
-- project that previously had them, run:
--   drop view if exists public.leaderboard_view;
--   drop function if exists public.leaderboard(int, text);
-- to clean them out (safe to run idempotently).
-- =============================================================================

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table public.profiles       enable row level security;
alter table public.portfolios     enable row level security;
alter table public.holdings       enable row level security;
alter table public.transactions   enable row level security;
alter table public.friends        enable row level security;
alter table public.transfers      enable row level security;
alter table public.coach_messages enable row level security;
alter table public.watchlist      enable row level security;
alter table public.limit_orders   enable row level security;

-- =============================================================================
-- Live-quote cache. The /api/live-quote Vercel function maintains this
-- table so all users share the same 10s-cached view of each symbol.
-- Reads are public (anyone browsing the market listings needs them);
-- writes are gated to the service-role key used by the serverless function.
-- =============================================================================
create table if not exists public.quote_cache (
  symbol             text primary key,
  price_paise        bigint not null,
  prev_close_paise   bigint,
  bid_paise          bigint,
  ask_paise          bigint,
  day_high_paise     bigint,
  day_low_paise      bigint,
  volume             bigint default 0,
  change_pct         double precision default 0,
  ts_ms              bigint not null,
  -- When OUR server wrote this row. Distinct from ts_ms (which is the
  -- upstream market time — could be hours stale during Yahoo lag). Cache
  -- TTL filtering uses cached_at_ms, freshness-badge logic uses ts_ms.
  cached_at_ms       bigint not null default (extract(epoch from now()) * 1000)::bigint,
  source             text not null default 'yahoo',
  updated_at         timestamptz not null default now()
);
alter table public.quote_cache add column if not exists cached_at_ms bigint not null default (extract(epoch from now()) * 1000)::bigint;
create index if not exists idx_quote_cache_cached_at on public.quote_cache (cached_at_ms desc);
create index if not exists idx_quote_cache_updated on public.quote_cache (updated_at desc);

-- DhanHQ instrument master: NSE symbol → Dhan security_id mapping.
-- Populated once from Dhan's api-scrip-master.csv when the user wires up
-- their Dhan API key. Until then this table is empty and the quote
-- endpoint transparently falls through to Yahoo.
create table if not exists public.dhan_instruments (
  symbol             text primary key,
  security_id        int not null,
  exchange_segment   text not null default 'NSE_EQ',
  instrument_type    text,
  lot_size           int,
  updated_at         timestamptz not null default now()
);

alter table public.quote_cache       enable row level security;
alter table public.dhan_instruments  enable row level security;

-- Public-read for the cache (needed by the Markets page for everyone
-- including anon visitors). Writes require the service role.
drop policy if exists "quote_cache_read"       on public.quote_cache;
drop policy if exists "dhan_instruments_read"  on public.dhan_instruments;
create policy "quote_cache_read"      on public.quote_cache      for select using (true);
create policy "dhan_instruments_read" on public.dhan_instruments for select using (true);

-- Security fix: the old `profiles_read_all` exposed email + parent_email to
-- every anon client. We now restrict the base table to self-reads only and
-- route everyone else through the `public_profiles` view below, which omits
-- the sensitive columns.
drop policy if exists "profiles_read_all"      on public.profiles;
drop policy if exists "profiles_self_read"     on public.profiles;
drop policy if exists "profiles_update_self"   on public.profiles;
drop policy if exists "profiles_insert_self"   on public.profiles;
create policy "profiles_self_read"   on public.profiles for select using (auth.uid() = id);
create policy "profiles_update_self" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
create policy "profiles_insert_self" on public.profiles for insert with check (auth.uid() = id);

-- Safe public directory: only non-sensitive columns. Used for friend-search
-- and display in the UI. Email, parent_email, age, class_code stay private.
create or replace view public.public_profiles
with (security_invoker = true) as
  select id, username, display_name, school, avatar_color, onboarded, created_at
  from public.profiles
  where onboarded = true;

-- Make the view readable by anon + authenticated. The underlying RLS still
-- enforces that nobody except `auth.uid() = id` can hit the base table, but
-- the view uses `security_invoker` so anon can see rows where onboarded is
-- true — we must re-grant via a SECURITY DEFINER function for cross-user
-- directory access. Simpler: grant select on the columns via a definer RPC.

create or replace function public.search_public_profiles(p_query text)
returns table (
  id uuid, username text, display_name text, school text,
  avatar_color text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_q text := lower(trim(coalesce(p_query, '')));
begin
  if length(v_q) < 2 then return; end if;
  return query
    select p.id, p.username, p.display_name, p.school, p.avatar_color
    from public.profiles p
    where p.onboarded = true
      and (lower(p.username) like v_q || '%'
           or lower(p.display_name) like '%' || v_q || '%')
    limit 10;
end;
$$;
grant execute on function public.search_public_profiles(text) to authenticated, anon;

-- Resolve a single profile by username for transfer UX (returns only safe
-- columns — never email/parent_email).
create or replace function public.profile_by_username(p_username text)
returns table (
  id uuid, username text, display_name text, avatar_color text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select p.id, p.username, p.display_name, p.avatar_color
    from public.profiles p
    where lower(p.username) = lower(trim(coalesce(p_username, '')))
    limit 1;
end;
$$;
grant execute on function public.profile_by_username(text) to authenticated;

-- Money tables are READ-ONLY to clients. Every write goes through a SECURITY
-- DEFINER RPC (apply_trade, apply_transfer, place_/cancel_/fill_limit_order),
-- which runs as the function owner and is unaffected by these policies.
--
-- These were `for all using (auth.uid() = user_id)` until 2026-09-13e. That is
-- an OWNERSHIP test, not an AUTHORSHIP test: it asks "is this row yours", never
-- "did a legitimate code path write it" — so a user could mint their own
-- holdings and set their own cash over PostgREST. Do not restore `for all`.
drop policy if exists "portfolios_self_all"  on public.portfolios;
drop policy if exists "portfolios_self_read" on public.portfolios;
create policy "portfolios_self_read" on public.portfolios for select
  using (auth.uid() = user_id);

drop policy if exists "holdings_self_all"  on public.holdings;
drop policy if exists "holdings_self_read" on public.holdings;
create policy "holdings_self_read" on public.holdings for select
  using (auth.uid() = user_id);

-- The ledger is written by apply_trade alone. `txn_self_insert` used to let a
-- client fabricate trade history that never moved cash.
drop policy if exists "txn_self_read"   on public.transactions;
drop policy if exists "txn_self_insert" on public.transactions;
create policy "txn_self_read" on public.transactions for select
  using (auth.uid() = user_id);

drop policy if exists "friends_self_all" on public.friends;
create policy "friends_self_all" on public.friends for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Transfers are written by apply_transfer / redeem_transfer_code only.
drop policy if exists "transfers_party_read" on public.transfers;
drop policy if exists "transfers_sender_insert" on public.transfers;
create policy "transfers_party_read" on public.transfers for select
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

drop policy if exists "coach_self_all" on public.coach_messages;
create policy "coach_self_all" on public.coach_messages for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "watchlist_self_all" on public.watchlist;
create policy "watchlist_self_all" on public.watchlist for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "orders_self_all"  on public.limit_orders;
drop policy if exists "orders_self_read" on public.limit_orders;
create policy "orders_self_read" on public.limit_orders for select
  using (auth.uid() = user_id);

-- NOTE: the matching table-grant revokes live at the END of this file, after
-- every table exists. RLS alone is not the gate — the grant is.

-- =============================================================================
-- AI response cache — dedupes identical queries across every user so the
-- second person to hover "P/E", search for "harshad mehta", or open a
-- similar portfolio digest gets a cached answer instantly for $0.
-- Bucket keys namespace the feature (explain, digest, nl_search, …) so
-- one cache table serves all AI features.
-- =============================================================================
create table if not exists public.ai_response_cache (
  bucket      text not null,
  cache_key   text not null,
  display_key text,
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  hit_count   int not null default 1,
  primary key (bucket, cache_key)
);
create index if not exists idx_ai_response_cache_bucket on public.ai_response_cache (bucket);
alter table public.ai_response_cache enable row level security;
drop policy if exists "ai_cache_public_read"  on public.ai_response_cache;
create policy "ai_cache_public_read" on public.ai_response_cache for select using (true);
-- No public write policy — only the server's SUPABASE_SERVICE_ROLE_KEY
-- writes to this table, via /api/ai-cache-put.

-- =============================================================================
-- portfolio_history — per-user portfolio value snapshots. Populated by:
--   (a) the admin_portfolio_backfill() RPC on initial deploy (historical rows)
--   (b) the on_transaction_insert trigger on every new trade (source='trade')
--   (c) hourly Vercel Cron calling admin_portfolio_backfill(today_only := true)
-- Enables instant portfolio-value-over-time graphs in the admin drill-down
-- without replaying every user's history on page load.
-- =============================================================================
create table if not exists public.portfolio_history (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  ts                   timestamptz not null default now(),
  total_value_paise    bigint not null,
  cash_paise           bigint not null,
  holdings_value_paise bigint not null,
  source               text not null check (source in ('trade','daily_snapshot','backfill')),
  created_at           timestamptz not null default now()
);
create index if not exists idx_portfolio_history_user_ts on public.portfolio_history (user_id, ts desc);
alter table public.portfolio_history enable row level security;
drop policy if exists "portfolio_history_self_read" on public.portfolio_history;
create policy "portfolio_history_self_read" on public.portfolio_history for select
  using (auth.uid() = user_id);
-- No public write policy — only service-role writes, via RPCs + triggers.

-- =============================================================================
-- admin_audit_log — every write the god-mode admin panel performs.
-- Captures before/after state (jsonb diff), actor IP, and a required reason
-- string so the admin has to justify every mutation.
-- No RLS public read: service-role only via /api/ai?op=admin-audit-log.
-- =============================================================================
create table if not exists public.admin_audit_log (
  id             uuid primary key default gen_random_uuid(),
  ts             timestamptz not null default now(),
  action         text not null,
  target_user_id uuid,
  target_kind    text,              -- e.g. 'user', 'transaction', 'env_var', 'deployment'
  target_id      text,              -- row-id / uuid / vercel id, etc.
  actor_ip       text,
  before_state   jsonb,
  after_state    jsonb,
  reason         text,
  note           text
);
create index if not exists idx_audit_ts      on public.admin_audit_log (ts desc);
create index if not exists idx_audit_target  on public.admin_audit_log (target_user_id);
create index if not exists idx_audit_action  on public.admin_audit_log (action);
alter table public.admin_audit_log enable row level security;
-- No policies — only SERVICE_ROLE_KEY bypasses RLS. Reads happen via /api/ai.

-- =============================================================================
-- admin_exec_sql(text) — SECURITY DEFINER RPC that lets the admin panel's
-- SQL editor run arbitrary SQL. Returns results as jsonb. Must be called
-- with the service-role key; Postgres itself has no other guard since
-- SECURITY DEFINER runs as the function owner.
--
-- THIS IS INTENTIONALLY A FOOTGUN. The admin frontend double-confirms any
-- DDL + mutating query; this function is the unconditional plumbing.
-- =============================================================================
create or replace function public.admin_exec_sql(p_sql text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
begin
  -- Wrap arbitrary SQL so both SELECTs and non-SELECTs return something.
  -- We execute via EXECUTE and aggregate any returned rows to jsonb.
  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t',
    p_sql
  ) into r;
  return jsonb_build_object('rows', r, 'count', jsonb_array_length(r));
exception when others then
  return jsonb_build_object(
    'error', SQLERRM,
    'sqlstate', SQLSTATE,
    'where', 'admin_exec_sql'
  );
end;
$$;
revoke all on function public.admin_exec_sql(text) from public, anon, authenticated;
grant execute on function public.admin_exec_sql(text) to service_role;

-- =============================================================================
-- admin_reset_user(uuid) — same effect as reset_my_portfolio() but targets
-- a specific user_id instead of auth.uid(). Service-role only.
-- =============================================================================
create or replace function public.admin_reset_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.holdings       where user_id = p_user_id;
  delete from public.transactions   where user_id = p_user_id;
  delete from public.watchlist      where user_id = p_user_id;
  delete from public.limit_orders   where user_id = p_user_id;
  delete from public.coach_messages where user_id = p_user_id;
  delete from public.transfers      where sender_id = p_user_id or recipient_id = p_user_id;
  delete from public.portfolio_history where user_id = p_user_id;
  update public.portfolios
     set cash_paise = starting_cash_paise,
         updated_at = now()
   where user_id = p_user_id;
  return jsonb_build_object('ok', true, 'reset_user_id', p_user_id, 'reset_at', now());
end;
$$;
revoke all on function public.admin_reset_user(uuid) from public, anon, authenticated;
grant execute on function public.admin_reset_user(uuid) to service_role;

-- =============================================================================
-- admin_reverse_trade(uuid) — delete a transaction and reverse its portfolio
-- effect (credit BUY back to cash + decrement holding qty, or vice versa).
-- Service-role only. Does NOT touch portfolio_history rows (those are
-- captured as-they-were; the audit trail stands).
-- =============================================================================
create or replace function public.admin_reverse_trade(p_txn_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.transactions;
begin
  select * into t from public.transactions where id = p_txn_id;
  if t.id is null then return jsonb_build_object('error', 'not_found'); end if;

  if t.side = 'BUY' then
    -- Refund cash, reduce holding
    update public.portfolios set cash_paise = cash_paise + t.value_paise, updated_at = now()
     where user_id = t.user_id;
    update public.holdings set qty = qty - t.qty, updated_at = now()
     where user_id = t.user_id and symbol = t.symbol;
    delete from public.holdings where user_id = t.user_id and symbol = t.symbol and qty <= 0;
  else
    -- Un-sell: debit cash, add back holding
    update public.portfolios set cash_paise = cash_paise - t.value_paise, updated_at = now()
     where user_id = t.user_id;
    insert into public.holdings (user_id, symbol, qty, avg_cost_paise, first_bought_at)
      values (t.user_id, t.symbol, t.qty, t.price_paise, now())
      on conflict (user_id, symbol) do update
        set qty = public.holdings.qty + excluded.qty,
            updated_at = now();
  end if;

  delete from public.transactions where id = p_txn_id;
  return jsonb_build_object('ok', true, 'reversed_txn_id', p_txn_id);
end;
$$;
revoke all on function public.admin_reverse_trade(uuid) from public, anon, authenticated;
grant execute on function public.admin_reverse_trade(uuid) to service_role;

-- =============================================================================
-- admin_refund_transfer(uuid) — for a completed transfer, credit the sender
-- back and debit the recipient. For a pending transfer, just cancel + refund
-- the sender. Service-role only.
-- =============================================================================
create or replace function public.admin_refund_transfer(p_transfer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  tf public.transfers;
begin
  select * into tf from public.transfers where id = p_transfer_id;
  if tf.id is null then return jsonb_build_object('error', 'not_found'); end if;

  if tf.status = 'completed' and tf.recipient_id is not null then
    update public.portfolios set cash_paise = cash_paise + tf.amount_paise, updated_at = now()
     where user_id = tf.sender_id;
    update public.portfolios set cash_paise = cash_paise - tf.amount_paise, updated_at = now()
     where user_id = tf.recipient_id;
  elsif tf.status = 'pending' then
    -- Sender already had cash reserved; refund it
    update public.portfolios set cash_paise = cash_paise + tf.amount_paise, updated_at = now()
     where user_id = tf.sender_id;
  end if;

  update public.transfers set status = 'cancelled', completed_at = now() where id = p_transfer_id;
  return jsonb_build_object('ok', true, 'refunded_transfer_id', p_transfer_id);
end;
$$;
revoke all on function public.admin_refund_transfer(uuid) from public, anon, authenticated;
grant execute on function public.admin_refund_transfer(uuid) to service_role;

-- =============================================================================
-- admin_portfolio_backfill(p_today_only bool) — reconstruct per-user
-- portfolio-value-over-time from the transaction log.
--
-- Modes:
--   p_today_only = false  → full backfill. Deletes all source='backfill' rows
--                          per user, then walks every user's transactions and
--                          emits daily snapshots up to today.
--   p_today_only = true   → called by the hourly Vercel Cron. Skips historical
--                          replay; just writes today's snapshot for everyone.
--
-- We use the cost-basis of each user's current holdings for the value — an
-- approximation but avoids needing historical per-symbol close prices. For
-- admin graphs this is accurate enough; when quote_cache has richer history,
-- we can upgrade to mark-to-market.
-- =============================================================================
create or replace function public.admin_portfolio_backfill(p_today_only boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_users int := 0;
  n_rows int := 0;
  u record;
  hv bigint;
  cv bigint;
begin
  for u in select user_id, cash_paise from public.portfolios loop
    n_users := n_users + 1;
    select coalesce(sum(qty * avg_cost_paise), 0)::bigint into hv
      from public.holdings where user_id = u.user_id;
    cv := u.cash_paise;
    if not p_today_only then
      -- Wipe previous backfill rows for this user before re-seeding.
      delete from public.portfolio_history
        where user_id = u.user_id and source = 'backfill';
    end if;
    insert into public.portfolio_history
      (user_id, ts, total_value_paise, cash_paise, holdings_value_paise, source)
      values (u.user_id, now(), hv + cv, cv, hv,
              case when p_today_only then 'daily_snapshot' else 'backfill' end);
    n_rows := n_rows + 1;
  end loop;
  return jsonb_build_object(
    'ok', true, 'users', n_users, 'rows_inserted', n_rows, 'ts', now(),
    'mode', case when p_today_only then 'today_only' else 'full' end
  );
end;
$$;
revoke all on function public.admin_portfolio_backfill(boolean) from public, anon, authenticated;
grant execute on function public.admin_portfolio_backfill(boolean) to service_role;

-- =============================================================================
-- Trigger: on every new transaction, snapshot the user's portfolio value.
-- Gives us a real-time source='trade' point in portfolio_history without
-- requiring the app to write it explicitly.
-- =============================================================================
create or replace function public.on_transaction_insert_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  hv bigint;
  cv bigint;
begin
  select coalesce(sum(qty * avg_cost_paise), 0)::bigint into hv
    from public.holdings where user_id = new.user_id;
  select cash_paise into cv from public.portfolios where user_id = new.user_id;
  insert into public.portfolio_history
    (user_id, ts, total_value_paise, cash_paise, holdings_value_paise, source)
    values (new.user_id, new.created_at, hv + coalesce(cv,0), coalesce(cv,0), hv, 'trade');
  return new;
end;
$$;
drop trigger if exists trg_transaction_portfolio_snapshot on public.transactions;
create trigger trg_transaction_portfolio_snapshot
  after insert on public.transactions
  for each row execute function public.on_transaction_insert_snapshot();

-- =============================================================================
-- Realtime
-- =============================================================================
do $$ begin alter publication supabase_realtime add table public.portfolios;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.transfers;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.transactions;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.limit_orders;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.coach_messages;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.profiles;
exception when duplicate_object then null; end $$;

-- =============================================================================
-- Table grants — the other half of the gate.
--
-- Supabase's project template runs
--   alter default privileges in schema public grant all on tables
--     to anon, authenticated;
-- so every table created here is born with INSERT/UPDATE/DELETE/TRUNCATE for
-- both roles. RLS decides WHICH ROWS; the grant decides WHETHER AT ALL. A
-- correct policy with a stray grant is still a hole, which is how holdings and
-- portfolios stayed client-writable until 2026-09-13e.
--
-- Placed at the end of the file because every table must already exist.
-- `mf_master` is created by supabase/migrations/2026-04-25d_mf_master.sql and
-- is revoked there / in 2026-09-13e, not here.
-- =============================================================================
revoke insert, update, delete, truncate on
  public.holdings,
  public.transactions,
  public.portfolios,
  public.limit_orders,
  public.transfers,
  public.portfolio_history,
  public.quote_cache,
  public.dhan_instruments
from public, anon, authenticated;

grant select on
  public.holdings,
  public.transactions,
  public.portfolios,
  public.limit_orders,
  public.transfers,
  public.portfolio_history
to authenticated;

-- Verify after running:
--   select relname,
--          has_table_privilege('authenticated', oid, 'INSERT') should_be_false,
--          has_table_privilege('authenticated', oid, 'SELECT') should_be_true
--     from pg_class where relnamespace = 'public'::regnamespace
--      and relname in ('holdings','portfolios','limit_orders','transactions');

-- Done.
