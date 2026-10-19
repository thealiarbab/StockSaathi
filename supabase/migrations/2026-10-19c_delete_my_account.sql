-- Settings -> Delete account used to sign the student out and set
-- profiles.onboarded = false. Nothing was erased: login, email, profile,
-- trades and activity all stayed, while privacy.html promises erasure
-- within 30 days. Found 2026-10-19 from an erasure request to grievance@.
--
-- delete_my_account() erases the caller and nothing else:
--   * takes no argument; the only id it ever uses is auth.uid() from the
--     caller's own JWT, so it cannot be pointed at another account
--   * refuses anonymous callers and admin accounts
--   * every DELETE is keyed on that one uid; if the auth.users delete
--     touches anything but exactly one row, or the account total drops by
--     anything but one, it raises and the whole call rolls back
--   * EXECUTE is granted to authenticated only
-- Deleting the auth.users row cascades to profiles, portfolios, holdings,
-- transactions, friends, transfers, coach_messages, watchlist,
-- limit_orders, portfolio_history, user_notices, user_events and
-- user_event_rollup. The chat tables have no foreign key to auth.users, so
-- they are cleared first. order_backfill_audit and
-- remediation_audit_2026_09 keep only a bare uuid, no personal data, as
-- the audit record.

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  before_total bigint;
  after_total bigint;
  n bigint;
begin
  if uid is null then
    raise exception 'not_signed_in' using errcode = '28000';
  end if;
  if exists (select 1 from public.admin_users where user_id = uid) then
    raise exception 'admin_accounts_cannot_self_delete' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users where id = uid) then
    raise exception 'account_not_found' using errcode = 'P0002';
  end if;

  select count(*) into before_total from auth.users;

  delete from public.chat_feedback where user_id = uid;
  delete from public.chat_shares   where user_id = uid;
  delete from public.chat_threads  where user_id = uid;

  delete from auth.users where id = uid;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'delete_guard: expected 1 account, got %', n;
  end if;

  select count(*) into after_total from auth.users;
  if after_total <> before_total - 1 then
    raise exception 'delete_guard: account total went % -> %', before_total, after_total;
  end if;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
