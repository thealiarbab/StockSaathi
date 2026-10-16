-- Send / receive money is removed from StockSaathi (16 Oct 2026).
--
-- 1. Every unclaimed redeem code still holds its sender's cash
--    (create_transfer_code takes it at creation). Give it back and tell them.
-- 2. Drop every RPC behind sending, receiving, codes and friends, so the
--    feature cannot be reached even by calling the API directly.
-- 3. Lock the tables. Rows stay as history: completed transfers moved real
--    (virtual) cash, and the ledger must still add up.

-- 1. Refund unclaimed codes, one notice per sender.
insert into public.user_notices (user_id, kind, title, body, payload)
select t.sender_id,
       'transfer_refunded',
       'Your unclaimed code is refunded',
       'Sending money is no longer part of StockSaathi. '
         || case when count(*) = 1 then 'The redeem code you made was never claimed, so the cash it was holding is back in your balance.'
                 else 'The ' || count(*) || ' redeem codes you made were never claimed, so the cash they were holding is back in your balance.' end,
       jsonb_build_object(
         'refund_total_inr', round(sum(t.amount_paise) / 100.0, 2),
         'cta', jsonb_build_object('href', '/portfolio', 'label', 'See my portfolio'))
  from public.transfers t
 where t.status = 'pending' and t.recipient_id is null
 group by t.sender_id;

update public.portfolios p
   set cash_paise = p.cash_paise + r.total, updated_at = now()
  from (select sender_id, sum(amount_paise) total
          from public.transfers
         where status = 'pending' and recipient_id is null
         group by sender_id) r
 where p.user_id = r.sender_id;

update public.transfers
   set status = 'cancelled', completed_at = now()
 where status = 'pending' and recipient_id is null;

-- 2. The feature's functions.
drop function if exists public.apply_transfer(text, bigint, text, text);
drop function if exists public.apply_transfer(text, bigint, text);
drop function if exists public.create_transfer_code(bigint, text, text);
drop function if exists public.redeem_transfer_code(text);
drop function if exists public.list_my_transfers(integer);
drop function if exists public.list_my_friends();
drop function if exists public.add_friend_by_username(text);
drop function if exists public.admin_refund_transfer(uuid);

-- 3. No client reads or writes either table any more.
revoke all on table public.transfers from anon, authenticated;
revoke all on table public.friends   from anon, authenticated;
