-- =============================================================================
-- 2026-09-27a  Make users whole for (1) limit orders the matcher slept through
--              and (2) buys executed at Yahoo's frozen 2024 SME price.
--
-- APPLIED TO PRODUCTION 2026-09-27. Full evidence: docs/ORDER_REMEDIATION_2026-09-27.md
--
-- (1) The order matcher was meant to run every 5 min; GitHub ran it ~2x/day,
--     once after the close. 11 pending orders had their limit traded through
--     (verified on Yahoo 5-minute bars AND the independent daily bar; mfapi.in
--     NAV for the liquid fund) and were never filled. Each is filled now at the
--     price a real exchange would have given at that moment: the bar's open
--     when the market opened through the limit, else the limit itself.
-- (2) For ten NSE SME stocks Yahoo's meta price was frozen at 2024-07-23 while
--     the stocks traded far lower (fixed in code: handlers/_yahoo_price.py).
--     19 buys still held were executed at that fake price. Each is re-priced to
--     what the stock actually traded at, at execution; the difference is
--     refunded in cash and the holding's average cost lowered to match.
--     Windfall SELLs at the fake price are NOT clawed back.
--
-- Cancelled orders are not filled: there is no record of when a cancel
-- happened, so a user's explicit withdrawal is respected.
-- Every change is written to remediation_audit_2026_09 with before/after.
-- =============================================================================

create table if not exists public.remediation_audit_2026_09 (
  id           bigserial primary key,
  kind         text not null,          -- 'late_fill' | 'stale_price_reprice'
  user_id      uuid not null,
  order_id     uuid,
  txn_id       uuid,
  symbol       text not null,
  side         text,
  qty          numeric(18,6),
  before_paise bigint,                 -- limit (fills) / price paid (reprices)
  fair_paise   bigint not null,
  cash_delta_paise bigint not null,
  evidence     text not null,
  applied_at   timestamptz not null default now()
);
alter table public.remediation_audit_2026_09 enable row level security;
revoke all on table public.remediation_audit_2026_09 from anon, authenticated;

-- ---- (1) late fills: _fill_limit_order_core with an explicit fair price -----
create function pg_temp.remediate_fill(p_order_id uuid, p_price bigint, p_evidence text)
returns void language plpgsql as $$
declare
  o record; v_value bigint; v_refund bigint := 0; v_hid uuid; v_hqty numeric(18,6);
  v_havg bigint; v_nqty numeric(18,6); v_txn uuid;
begin
  select * into o from public.limit_orders where id = p_order_id for update;
  if not found then raise exception 'order % not found', p_order_id; end if;
  if o.status <> 'pending' then raise notice 'skip %: %', p_order_id, o.status; return; end if;
  if o.side = 'BUY' and p_price > o.limit_price_paise then raise exception 'fair above limit %', p_order_id; end if;
  if o.side = 'SELL' and p_price < o.limit_price_paise then raise exception 'fair below limit %', p_order_id; end if;
  v_value := round(o.qty * p_price)::bigint;
  perform 1 from public.portfolios where user_id = o.user_id for update;
  if o.side = 'BUY' then
    v_refund := o.reserved_cash - v_value;
    if v_refund < 0 then raise exception 'reservation underflow %', p_order_id; end if;
    update public.portfolios set cash_paise = cash_paise + v_refund, updated_at = now() where user_id = o.user_id;
    select id, qty, avg_cost_paise into v_hid, v_hqty, v_havg from public.holdings
      where user_id = o.user_id and symbol = o.symbol for update;
    if v_hid is not null then
      v_nqty := v_hqty + o.qty;
      update public.holdings set qty = v_nqty,
        avg_cost_paise = round(((v_havg::numeric * v_hqty) + v_value) / v_nqty)::bigint, updated_at = now()
        where id = v_hid;
    else
      insert into public.holdings (user_id, symbol, qty, avg_cost_paise) values (o.user_id, o.symbol, o.qty, p_price);
    end if;
  else
    select id, qty into v_hid, v_hqty from public.holdings where user_id = o.user_id and symbol = o.symbol for update;
    if v_hid is null or v_hqty < o.qty then raise exception 'insufficient holding %', p_order_id; end if;
    v_nqty := v_hqty - o.qty;
    if v_nqty <= 1e-9 then delete from public.holdings where id = v_hid;
    else update public.holdings set qty = v_nqty, updated_at = now() where id = v_hid; end if;
    update public.portfolios set cash_paise = cash_paise + v_value, updated_at = now() where user_id = o.user_id;
  end if;
  insert into public.transactions (user_id, symbol, side, qty, price_paise, value_paise, bias_flags, idempotency_key)
    values (o.user_id, o.symbol, o.side, o.qty, p_price, v_value,
            jsonb_build_array(jsonb_build_object('bias','limit_order_filled','order_id',p_order_id),
                              jsonb_build_object('bias','remediation_2026_09_27','evidence',p_evidence)),
            'limit_' || p_order_id::text)
    returning id into v_txn;
  update public.limit_orders set status = 'filled', filled_at = now(), filled_price_paise = p_price,
         filled_txn_id = v_txn where id = p_order_id;
  insert into public.remediation_audit_2026_09
    (kind, user_id, order_id, txn_id, symbol, side, qty, before_paise, fair_paise, cash_delta_paise, evidence)
    values ('late_fill', o.user_id, p_order_id, v_txn, o.symbol, o.side, o.qty, o.limit_price_paise, p_price,
            case when o.side = 'BUY' then -v_value else v_value end, p_evidence);
end $$;

-- ---- (2) stale-price buys: re-price, refund, lower average cost --------------
create function pg_temp.remediate_reprice(p_txn uuid, p_fair bigint, p_evidence text)
returns void language plpgsql as $$
declare t record; v_new_value bigint; v_refund bigint; h record;
begin
  select * into t from public.transactions where id = p_txn for update;
  if not found then raise exception 'txn % not found', p_txn; end if;
  if t.side <> 'BUY' then raise exception 'txn % is not a buy', p_txn; end if;
  if t.bias_flags::text like '%price_corrected%' then raise notice 'skip % already corrected', p_txn; return; end if;
  if p_fair >= t.price_paise then raise exception 'fair not below paid %', p_txn; end if;
  v_new_value := round(t.qty * p_fair)::bigint;
  v_refund := t.value_paise - v_new_value;
  perform 1 from public.portfolios where user_id = t.user_id for update;
  select * into h from public.holdings where user_id = t.user_id and symbol = t.symbol for update;
  if not found or h.qty < t.qty then raise exception 'holding for txn % no longer covers it', p_txn; end if;
  update public.portfolios set cash_paise = cash_paise + v_refund, updated_at = now() where user_id = t.user_id;
  update public.holdings set avg_cost_paise = greatest(1, round((h.avg_cost_paise::numeric * h.qty - v_refund) / h.qty))::bigint,
         updated_at = now() where id = h.id;
  update public.transactions set price_paise = p_fair, value_paise = v_new_value,
         bias_flags = coalesce(bias_flags, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
           'bias','price_corrected','was_paise',t.price_paise,'evidence',p_evidence,'on','2026-09-27'))
         where id = p_txn;
  update public.limit_orders set filled_price_paise = p_fair where filled_txn_id = p_txn;
  insert into public.remediation_audit_2026_09
    (kind, user_id, txn_id, symbol, side, qty, before_paise, fair_paise, cash_delta_paise, evidence)
    values ('stale_price_reprice', t.user_id, p_txn, t.symbol, 'BUY', t.qty, t.price_paise, p_fair, v_refund, p_evidence);
end $$;

select pg_temp.remediate_fill('9aa042f3-e94a-4be1-8e58-79d1bb2b78fb', 229680, 'TCS SELL limit 2293.40: market traded through it at 2026-09-15 10:15 IST (5m bar O2296.80 H2309.00 L2296.80; daily bar confirms), fair price 2296.80');
select pg_temp.remediate_fill('5da9204b-d898-4efa-9fd4-d9da4b6f0a62', 229680, 'TCS SELL limit 2294.30: market traded through it at 2026-09-15 10:15 IST (5m bar O2296.80 H2309.00 L2296.80; daily bar confirms), fair price 2296.80');
select pg_temp.remediate_fill('208ef377-cd3d-4b15-88e5-6c39e1277059', 229680, 'TCS SELL limit 2294.90: market traded through it at 2026-09-15 10:15 IST (5m bar O2296.80 H2309.00 L2296.80; daily bar confirms), fair price 2296.80');
select pg_temp.remediate_fill('23e16702-2baa-42d7-ac12-666305e31014', 20323, '20MICRONS BUY limit 203.23: market traded through it at 2026-09-17 09:15 IST (5m bar O203.23 H206.50 L203.23; daily bar confirms), fair price 203.23');
select pg_temp.remediate_fill('55511acc-0ae5-46fe-9bf4-ac76d8b0b190', 104270, '360ONE BUY limit 1045.60: market traded through it at 2026-09-17 09:15 IST (5m bar O1042.70 H1049.90 L1037.10; daily bar confirms), fair price 1042.70');
select pg_temp.remediate_fill('d8e0db5c-696b-46d2-84ed-555f2eb8200b', 4860, 'AARTECH BUY limit 50.24: market traded through it at 2026-09-17 09:15 IST (5m bar O48.60 H51.45 L48.60; daily bar confirms), fair price 48.60');
select pg_temp.remediate_fill('33b881d5-aa7d-476f-98af-956fdfde56e9', 20828, '20MICRONS BUY limit 208.28: market traded through it at 2026-09-21 09:15 IST (5m bar O208.28 H210.69 L207.41; daily bar confirms), fair price 208.28');
select pg_temp.remediate_fill('43e27563-6b11-4aed-b210-1c6adb056299', 20828, '20MICRONS BUY limit 208.28: market traded through it at 2026-09-21 09:15 IST (5m bar O208.28 H210.69 L207.41; daily bar confirms), fair price 208.28');
select pg_temp.remediate_fill('10f67469-c7bf-4763-96fb-d92312699c0d', 99880, 'AUBANK BUY limit 1000.10: market traded through it at 2026-09-25 09:15 IST (5m bar O998.80 H1005.00 L998.80; daily bar confirms), fair price 998.80');
select pg_temp.remediate_fill('68a74186-c6ad-490e-ae13-a8c98a2593bf', 100517, 'MF_125343 BUY limit 1005.18: NAV 1005.1749 on 2026-09-25 (mfapi.in), first NAV after the 2026-09-24 23:07 IST order');
select pg_temp.remediate_fill('31e46db2-4288-407b-8bf5-86f90160d1ca', 100517, 'MF_125343 BUY limit 1005.18: NAV 1005.1749 on 2026-09-25 (mfapi.in), first NAV after the 2026-09-24 23:07 IST order');
select pg_temp.remediate_reprice('4d72981b-f21e-46bf-9c58-54eb2a349c47', 1850, 'AATMAJ bought at stale Yahoo price 26.75; actually traded 18.50 (open 2026-07-27) at execution 2026-07-27 09:15 IST');
select pg_temp.remediate_reprice('8112ca83-4d35-449e-8204-31ac45db1ece', 1825, 'AATMAJ bought at stale Yahoo price 26.75; actually traded 18.25 (last close 2026-08-27) at execution 2026-09-02 09:15 IST');
select pg_temp.remediate_reprice('ee6258dd-6259-4f38-99ae-bc590f3d73ce', 1525, 'AGNI bought at stale Yahoo price 51.82; actually traded 15.25 (last close 2026-09-03) at execution 2026-09-04 11:39 IST');
select pg_temp.remediate_reprice('74c678ad-dca8-4c64-bad6-8abeb861a0ce', 4590, 'AGUL bought at stale Yahoo price 62.90; actually traded 45.90 (open 2026-08-31) at execution 2026-08-31 15:01 IST');
select pg_temp.remediate_reprice('e35f3938-07c0-4fbb-a676-d7d177814219', 4590, 'AGUL bought at stale Yahoo price 62.90; actually traded 45.90 (last close 2026-08-31) at execution 2026-09-02 09:15 IST');
select pg_temp.remediate_reprice('a67600f9-afd5-47b2-9b8b-9ace6fa7b693', 4590, 'AGUL bought at stale Yahoo price 62.92; actually traded 45.90 (last close 2026-08-31) at execution 2026-09-04 12:01 IST');
select pg_temp.remediate_reprice('4c5cdc39-261a-4e01-8f5b-875965e8160f', 4575, 'AGUL bought at stale Yahoo price 80.00; actually traded 45.75 (open 2026-09-09) at execution 2026-09-09 09:15 IST');
select pg_temp.remediate_reprice('cad5d2be-d13d-4ef6-95e0-6bdadbff5917', 1635, 'AILIMITED bought at stale Yahoo price 94.00; actually traded 16.35 (last close 2026-08-21) at execution 2026-08-24 09:15 IST');
select pg_temp.remediate_reprice('fcc68f89-fab0-42bf-92c9-037f76be467d', 2225, 'AILIMITED bought at stale Yahoo price 94.02; actually traded 22.25 (open 2026-09-04) at execution 2026-09-04 11:07 IST');
select pg_temp.remediate_reprice('ff800097-d92d-46ec-826a-72f5157e7bfd', 2225, 'AILIMITED bought at stale Yahoo price 94.06; actually traded 22.25 (open 2026-09-04) at execution 2026-09-04 11:27 IST');
select pg_temp.remediate_reprice('412ba236-ce70-4aab-8cd7-17ef2f233335', 1640, 'AILIMITED bought at stale Yahoo price 94.00; actually traded 16.40 (open 2026-09-21) at execution 2026-09-21 12:26 IST');
select pg_temp.remediate_reprice('79d50f2a-94f8-4e6a-88ab-b6f416e72a07', 1560, 'AILIMITED bought at stale Yahoo price 94.00; actually traded 15.60 (last close 2026-09-23) at execution 2026-09-24 12:59 IST');
select pg_temp.remediate_reprice('aaaf0740-fc3b-4022-a630-a31118cde6b2', 1560, 'AILIMITED bought at stale Yahoo price 94.00; actually traded 15.60 (last close 2026-09-23) at execution 2026-09-24 13:07 IST');
select pg_temp.remediate_reprice('794e7d8d-b1c5-46c8-b9c9-58f49f44ffaf', 12800, 'DTL bought at stale Yahoo price 186.44; actually traded 128.00 (last close 2026-09-02) at execution 2026-09-04 10:50 IST');
select pg_temp.remediate_reprice('d1918f4e-09e9-400d-b84b-801851d7de5c', 8400, 'GOLDKART bought at stale Yahoo price 126.00; actually traded 84.00 (last close 2026-08-21) at execution 2026-08-25 09:15 IST');
select pg_temp.remediate_reprice('b26cdf3b-54b9-4f17-9c91-57100fa7f19f', 760, 'GOLDSTAR bought at stale Yahoo price 12.35; actually traded 7.60 (open 2026-09-08) at execution 2026-09-08 09:15 IST');
select pg_temp.remediate_reprice('f1f83078-ac66-49bb-a67b-74e4e85563a5', 760, 'GOLDSTAR bought at stale Yahoo price 12.35; actually traded 7.60 (open 2026-09-08) at execution 2026-09-08 09:15 IST');
select pg_temp.remediate_reprice('433a1f84-9a7b-4827-b285-de78ed22f04b', 1545, 'NIDAN bought at stale Yahoo price 33.01; actually traded 15.45 (open 2026-09-04) at execution 2026-09-04 10:54 IST');
select pg_temp.remediate_reprice('380d4cfb-7703-42ec-ab41-0a3f5863a6b3', 1410, 'NIDAN bought at stale Yahoo price 33.00; actually traded 14.10 (open 2026-09-07) at execution 2026-09-07 14:07 IST');

drop function pg_temp.remediate_fill(uuid, bigint, text);
drop function pg_temp.remediate_reprice(uuid, bigint, text);
