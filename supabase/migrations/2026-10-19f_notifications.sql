-- =============================================================================
-- Notifications: an in-app inbox (the bell) and web push to the user's phone.
--
-- public.notifications is the inbox. Rows come from the database itself, so
-- nothing depends on the user's tab being open:
--   * a LIMIT / AMO order filling (trigger on limit_orders), and
--   * every personal notice the server already writes to user_notices
--     (order cancelled / expiring / MF allotted / refunds), mirrored here.
--     user_notices keeps its job of the one-off modal; release notes
--     (kind 'whats_new') are not mirrored.
--
-- public.push_subscriptions holds one row per browser that allowed push
-- (endpoint + keys from PushManager.subscribe), with the categories that
-- device wants. Saved through save_push_subscription(), which takes the
-- endpoint over for the signed-in user (a shared phone changes hands).
--
-- Sending: an inserted notification whose user has a live subscription
-- pokes the push-dispatch Edge Function through pg_net (bearer = Vault
-- secret push_hook_secret). It encrypts and sends (RFC 8291 / 8292) and sets
-- push_state. Between 22:00 and 07:00 IST pushes wait ('deferred') and the
-- notify-morning cron flushes them at 07:05 IST; the inbox has them at once.
--
-- Written without DROP / DELETE (the Supabase connector cannot run them).
-- =============================================================================

create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  kind        text not null,
  category    text not null default 'account' check (category in ('orders','account','coach','achievements')),
  title       text not null,
  body        text not null default '',
  url         text,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  push_state  text not null default 'none' check (push_state in ('none','pending','deferred','sent','failed'))
);
create index if not exists notifications_user_time on public.notifications (user_id, created_at desc);
create index if not exists notifications_push_waiting on public.notifications (push_state) where push_state in ('pending','deferred');
alter table public.notifications enable row level security;
revoke all on table public.notifications from anon, authenticated;
grant select on table public.notifications to authenticated;
create policy notifications_own_read on public.notifications for select to authenticated
  using ((select auth.uid()) = user_id);

create table if not exists public.push_subscriptions (
  endpoint    text primary key,
  user_id     uuid not null,
  p256dh      text not null,
  auth        text not null,
  categories  text[] not null default array['orders','account','coach','achievements'],
  user_agent  text,
  disabled    boolean not null default false,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  fail_count  integer not null default 0
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id) where not disabled;
alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from anon, authenticated;
grant select on table public.push_subscriptions to authenticated;
create policy push_subscriptions_own_read on public.push_subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);

-- ---- Client RPCs -------------------------------------------------------------

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer language sql security definer set search_path to 'public' as $$
  with u as (
    update public.notifications set read_at = now()
     where user_id = auth.uid() and read_at is null
       and (p_ids is null or id = any(p_ids))
    returning 1)
  select count(*)::int from u;
$$;
revoke execute on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

create or replace function public.save_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_categories text[] default null, p_user_agent text default null, p_disabled boolean default false)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_endpoint !~ '^https://' or length(p_endpoint) > 1000 then raise exception 'bad endpoint'; end if;
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth, categories, user_agent, disabled)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth,
          coalesce(p_categories, array['orders','account','coach','achievements']), left(p_user_agent, 200), p_disabled)
  on conflict (endpoint) do update
     set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth,
         categories = coalesce(p_categories, public.push_subscriptions.categories),
         user_agent = excluded.user_agent, disabled = p_disabled, fail_count = 0;
end;
$$;
revoke execute on function public.save_push_subscription(text, text, text, text[], text, boolean) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text[], text, boolean) to authenticated;

-- ---- Producing notifications -----------------------------------------------

create or replace function public._order_label(p_side text, p_qty numeric, p_symbol text, p_type text)
returns text language sql immutable as $$
  select case when p_type = 'MF' then initcap(lower(p_side)) || ' ' || p_symbol
              else initcap(lower(p_side)) || ' ' || trim(to_char(p_qty, 'FM999999999990.####')) || ' ' || p_symbol end;
$$;

-- An order filled. MF allotments already write a user_notice (mirrored below).
create or replace function public._notify_order_filled() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.status = 'filled' and old.status is distinct from 'filled' and new.order_type <> 'MF' then
    insert into public.notifications (user_id, kind, category, title, body, url, payload)
    values (new.user_id, 'order_filled', 'orders',
      _order_label(new.side, new.qty, new.symbol, new.order_type) || ' filled',
      'At ₹' || to_char(coalesce(new.filled_price_paise, new.limit_price_paise) / 100.0, 'FM99,99,99,99,990.00')
        || case when new.order_type = 'AMO_MARKET' then ', the first live price after the open.' else '.' end,
      '/stocks/' || new.symbol,
      jsonb_build_object('order_id', new.id, 'symbol', new.symbol, 'side', new.side));
  end if;
  return new;
end;
$$;
create or replace trigger trg_notify_order_filled after update of status on public.limit_orders
  for each row execute function public._notify_order_filled();

-- Every personal notice except release notes also lands in the inbox.
create or replace function public._mirror_user_notice() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.kind = 'whats_new' then return new; end if;
  insert into public.notifications (user_id, kind, category, title, body, url, payload)
  values (new.user_id, new.kind,
    case when new.kind like 'order%' then 'orders' else 'account' end,
    coalesce(nullif(new.title, ''), 'A note from StockSaathi'),
    left(coalesce(new.body, ''), 600),
    case when new.kind like 'order%' then '/orders' else null end,
    jsonb_build_object('notice_id', new.id));
  return new;
end;
$$;
create or replace trigger trg_mirror_user_notice after insert on public.user_notices
  for each row execute function public._mirror_user_notice();

-- ---- Push dispatch ------------------------------------------------------------

create or replace function public._ist_quiet_hours() returns boolean language sql stable as $$
  select extract(hour from (now() at time zone 'Asia/Kolkata')) >= 22
      or extract(hour from (now() at time zone 'Asia/Kolkata')) < 7;
$$;

create or replace function public._push_poke(p_body jsonb) returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_secret text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_hook_secret';
  if v_secret is null then return; end if;
  perform net.http_post(
    url := 'https://hwlmwraowcylxzdpumca.supabase.co/functions/v1/push-dispatch',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    body := p_body,
    timeout_milliseconds := 10000);
end;
$$;
revoke execute on function public._push_poke(jsonb) from public, anon, authenticated;

create or replace function public._notification_push() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if not exists (select 1 from public.push_subscriptions s
                  where s.user_id = new.user_id and not s.disabled and new.category = any(s.categories)) then
    return new;   -- push_state stays 'none'
  end if;
  if _ist_quiet_hours() then
    update public.notifications set push_state = 'deferred' where id = new.id;
  else
    update public.notifications set push_state = 'pending' where id = new.id;
    perform _push_poke(jsonb_build_object('id', new.id));
  end if;
  return new;
end;
$$;
create or replace trigger trg_notification_push after insert on public.notifications
  for each row execute function public._notification_push();

-- 07:05 IST: send what waited overnight.
create or replace function public.admin_flush_deferred_pushes() returns integer
language plpgsql security definer set search_path to 'public' as $$
declare n integer;
begin
  update public.notifications set push_state = 'pending'
   where push_state = 'deferred' and created_at > now() - interval '12 hours';
  get diagnostics n = row_count;
  if n > 0 then perform _push_poke(jsonb_build_object('flush', true)); end if;
  return n;
end;
$$;
revoke execute on function public.admin_flush_deferred_pushes() from public, anon, authenticated;

select cron.schedule('notify-morning', '35 1 * * *', 'select public.admin_flush_deferred_pushes()');

alter publication supabase_realtime add table public.notifications;
