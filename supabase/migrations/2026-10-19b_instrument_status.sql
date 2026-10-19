-- =============================================================================
-- Listing status: a stock that cannot be traded on the exchange cannot be
-- traded here.
--
-- WHY: StockSaathi had no idea whether a stock was still listed. TUNTEX-RE1 (a
-- rights entitlement, BSE group R) traded 28 Sep to 16 Oct 2026 and then
-- ended, as every rights entitlement does; on 19 Oct it was still in the
-- universe, still on BSE's "Active" list, and the app still took an order for
-- it. Same gap for any suspended or delisted company.
--
-- instrument_status holds every stock that is NOT normally tradeable (a stock
-- with no row is active). A trigger on transactions and limit_orders refuses
-- such a stock, so every path is covered: market orders (apply_trade), limit
-- and at-the-open orders (place_limit_order) and the matcher's fills.
--
-- Fed by:
--   admin_set_instrument_status(rows) — the exchanges' suspended/delisted
--     lists (universe-refresh.yml), and manual entries;
--   admin_refresh_instrument_status() — after each end-of-day import: a
--     rights entitlement that has stopped trading has expired.
-- Moving a stock out of 'active' cancels its pending orders (cash held for a
-- buy comes back) and tells holders, once. Rows sent as 'active' only update
-- an existing row (lifting a suspension); they never add one.
--
-- Applied 2026-10-19 statement by statement. The Supabase connector waits for
-- a confirmation on any statement containing DROP, which never arrives in an
-- agent session, so it times out: this file uses no DROP at all (no temp
-- tables, CREATE OR REPLACE TRIGGER, no DROP POLICY).
-- =============================================================================

create table if not exists public.instrument_status (
  symbol          text primary key,
  status          text not null check (status in ('active', 'suspended', 'delisted', 'expired')),
  reason          text,
  effective_date  date,
  last_trade_date date,
  source          text not null default 'manual',
  updated_at      timestamptz not null default now()
);
alter table public.instrument_status enable row level security;
revoke all on table public.instrument_status from anon, authenticated;
grant select on table public.instrument_status to anon, authenticated;
create policy instrument_status_read on public.instrument_status for select to anon, authenticated using (true);

-- Why a symbol cannot be traded, or null when it can.
create or replace function public.instrument_block_reason(p_symbol text)
returns text language sql stable security definer set search_path to 'public'
as $$
  select case s.status
    when 'delisted' then format('%s has been delisted%s, so it can no longer be bought or sold.',
      s.symbol, coalesce(' (' || to_char(s.effective_date, 'FMDD Mon YYYY') || ')', ''))
    when 'suspended' then format('The exchange has suspended trading in %s%s. Orders are paused until it lifts the suspension.',
      s.symbol, coalesce(' since ' || to_char(s.effective_date, 'FMDD Mon YYYY'), ''))
    when 'expired' then format('%s was a rights entitlement, a temporary security that trades only during a rights issue. Its trading window ended%s, so it can no longer be bought or sold.',
      s.symbol, coalesce(' after ' || to_char(s.last_trade_date, 'FMDD Mon YYYY'), ''))
  end
  from public.instrument_status s
  where s.symbol = p_symbol and s.status <> 'active';
$$;
grant execute on function public.instrument_block_reason(text) to anon, authenticated;

create or replace function public._guard_tradeable()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare v_reason text;
begin
  if new.symbol like 'MF\_%' then return new; end if;
  v_reason := public.instrument_block_reason(new.symbol);
  if v_reason is not null then raise exception '%', v_reason; end if;
  return new;
end;
$$;
revoke execute on function public._guard_tradeable() from public, anon, authenticated;

create or replace trigger trg_guard_tradeable before insert on public.transactions
  for each row execute function public._guard_tradeable();
create or replace trigger trg_guard_tradeable before insert on public.limit_orders
  for each row execute function public._guard_tradeable();

-- rows: [{"symbol","status","reason","effective_date","last_trade_date","source"}]
create or replace function public.admin_set_instrument_status(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare
  v_in jsonb;
  v_block text[];
  n_set int := 0; n_cancelled int := 0; n_holders int := 0;
begin
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_in from (
    select distinct on (upper(trim(r->>'symbol')))
           upper(trim(r->>'symbol')) as symbol,
           lower(coalesce(r->>'status', 'active')) as status,
           nullif(r->>'reason', '') as reason,
           nullif(r->>'effective_date', '')::date as effective_date,
           nullif(r->>'last_trade_date', '')::date as last_trade_date,
           coalesce(nullif(r->>'source', ''), 'manual') as source
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
     where coalesce(r->>'symbol', '') <> ''
       and lower(coalesce(r->>'status', 'active')) in ('active', 'suspended', 'delisted', 'expired')) x;

  -- Newly blocked: was active (or unknown), now not.
  select coalesce(array_agg(i->>'symbol'), '{}') into v_block
    from jsonb_array_elements(v_in) i
    left join public.instrument_status s on s.symbol = i->>'symbol'
   where i->>'status' <> 'active' and coalesce(s.status, 'active') = 'active';

  insert into public.instrument_status as t (symbol, status, reason, effective_date, last_trade_date, source, updated_at)
    select i->>'symbol', i->>'status', i->>'reason', (i->>'effective_date')::date,
           (i->>'last_trade_date')::date, i->>'source', now()
      from jsonb_array_elements(v_in) i
     where i->>'status' <> 'active'
        or exists (select 1 from public.instrument_status e where e.symbol = i->>'symbol')
  on conflict (symbol) do update
    set status = excluded.status, reason = excluded.reason,
        effective_date = coalesce(excluded.effective_date, t.effective_date),
        last_trade_date = coalesce(excluded.last_trade_date, t.last_trade_date),
        source = excluded.source, updated_at = now()
    where (t.status, coalesce(t.reason, ''), t.effective_date, t.last_trade_date)
          is distinct from (excluded.status, coalesce(excluded.reason, ''), coalesce(excluded.effective_date, t.effective_date), coalesce(excluded.last_trade_date, t.last_trade_date));
  get diagnostics n_set = row_count;

  -- Pending orders on a newly blocked stock cannot fill: close them, refund
  -- the cash held for buys, and tell each owner once.
  with c as (
    update public.limit_orders o
       set status = 'cancelled', cancelled_at = now(), cancel_reason = 'not_tradeable'
     where o.symbol = any(v_block) and o.status = 'pending'
    returning o.user_id, o.symbol, o.side, o.qty, o.reserved_cash),
  refund as (
    update public.portfolios p set cash_paise = p.cash_paise + r.amt, updated_at = now()
      from (select user_id, sum(reserved_cash) amt from c where side = 'BUY' and reserved_cash > 0 group by 1) r
     where p.user_id = r.user_id
    returning 1),
  note as (
    insert into public.user_notices (user_id, kind, title, body, payload)
    select c.user_id, 'order_not_tradeable',
      case when count(*) = 1 then 'An order was closed' else format('%s orders were closed', count(*)) end,
      string_agg(distinct public.instrument_block_reason(c.symbol), ' ') ||
        case when sum(case when c.side = 'BUY' then c.reserved_cash else 0 end) > 0
             then ' The cash held for your order is back in your account.' else '' end,
      jsonb_build_object('cta', jsonb_build_object('label', 'See my portfolio', 'href', '/portfolio'),
        'orders', jsonb_agg(jsonb_build_object('side', c.side, 'symbol', c.symbol, 'qty', c.qty, 'outcome', 'closed')))
    from c group by c.user_id
    returning 1)
  select count(*) into n_cancelled from c;

  -- Holders: told once. Their shares stay in the portfolio at the last price.
  insert into public.user_notices (user_id, kind, title, body, payload)
  select h.user_id, 'holding_not_tradeable',
    format('%s can no longer be traded', h.symbol),
    public.instrument_block_reason(h.symbol) ||
      ' Your shares stay in your portfolio, valued at the last traded price.',
    jsonb_build_object('symbol', h.symbol, 'qty', h.qty,
      'cta', jsonb_build_object('label', 'See my portfolio', 'href', '/portfolio'))
  from public.holdings h where h.symbol = any(v_block);
  get diagnostics n_holders = row_count;

  return jsonb_build_object('ok', true, 'changed', n_set, 'newly_blocked', to_jsonb(v_block),
    'orders_closed', n_cancelled, 'holders_told', n_holders);
end;
$$;
revoke execute on function public.admin_set_instrument_status(jsonb) from public, anon, authenticated;
grant execute on function public.admin_set_instrument_status(jsonb) to service_role;

-- After an end-of-day import: a rights entitlement (BSE group R / a -RE
-- symbol, NSE series RE) whose last trade is older than that exchange's
-- latest session has expired. They trade every day of their window, then end.
create or replace function public.admin_refresh_instrument_status()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_rows jsonb;
begin
  with bse_last as (select max(trade_date) d from public.bse_eod_prices),
       nse_last as (select max(trade_date) d from public.nse_eod_prices),
       re as (
         select symbol, max(trade_date) last_d, 'BSE' ex
           from public.bse_eod_prices
          where bse_group = 'R' or symbol ~ '-RE[0-9]*$'
          group by symbol
         union all
         select symbol, max(trade_date), 'NSE'
           from public.nse_eod_prices
          where series in ('RE', 'E1') or symbol ~ '-RE[0-9]*$'
          group by symbol)
  select coalesce(jsonb_agg(jsonb_build_object(
           'symbol', re.symbol, 'status', 'expired', 'source', 'eod_rule',
           'reason', 'rights entitlement stopped trading',
           'last_trade_date', re.last_d)), '[]'::jsonb)
    into v_rows
    from re
   where re.last_d < (case re.ex when 'BSE' then (select d from bse_last) else (select d from nse_last) end)
     and not exists (select 1 from public.instrument_status s where s.symbol = re.symbol and s.status <> 'active');
  return public.admin_set_instrument_status(v_rows);
end;
$$;
revoke execute on function public.admin_refresh_instrument_status() from public, anon, authenticated;

grant execute on function public.admin_refresh_instrument_status() to service_role;

-- 19 Oct 2026: TUNTEX-RE1 last traded 16 Oct; set by hand on the day.
-- select public.admin_set_instrument_status('[{"symbol":"TUNTEX-RE1","status":"expired","last_trade_date":"2026-10-16","effective_date":"2026-10-19","source":"manual"}]');
