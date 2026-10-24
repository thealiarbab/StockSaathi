-- =============================================================================
-- Fill emails: "your order filled" by email for users push can't reach.
--
-- 24 Oct: 1,346 order_filled notices since 5 Oct, 1,175 never read, and 28 of
-- 2,964 new users with push on. 85% of fills land at 9:15-10:00 IST, so
-- handlers/fill-email.py sends one email per user from a cron just after.
--
-- Who gets one: an unread order_filled notice from the last 24 h, not emailed
-- yet, and the user has no live push subscription for orders (push already
-- told them) and has not turned order emails off (profiles.order_emails,
-- Settings > Notifications).
--
-- Written without DROP / DELETE (the Supabase connector cannot run them).
-- =============================================================================

alter table public.notifications add column if not exists emailed_at timestamptz;
alter table public.profiles add column if not exists order_emails boolean not null default true;

create index if not exists notifications_fill_email_due
  on public.notifications (created_at) where kind = 'order_filled' and emailed_at is null and read_at is null;

-- One row per user who is due an email, with their fills oldest first.
create or replace function public.fill_email_due(p_hours int default 24)
returns table (user_id uuid, email text, display_name text, fills jsonb)
language sql stable security definer set search_path = public as $$
  select n.user_id, p.email, p.display_name,
         jsonb_agg(jsonb_build_object('id', n.id, 'title', n.title, 'body', n.body, 'url', n.url,
                                      'symbol', n.payload->>'symbol', 'side', n.payload->>'side',
                                      'at', n.created_at) order by n.created_at)
  from public.notifications n
  join public.profiles p on p.id = n.user_id
  where n.kind = 'order_filled' and n.emailed_at is null and n.read_at is null
    and n.created_at > now() - make_interval(hours => greatest(1, least(p_hours, 72)))
    and p.order_emails and p.email is not null and p.email like '%@%'
    and not exists (select 1 from public.push_subscriptions s
                    where s.user_id = n.user_id and not s.disabled and 'orders' = any(s.categories))
  group by n.user_id, p.email, p.display_name;
$$;

create or replace function public.mark_fill_emailed(p_ids uuid[])
returns int language sql security definer set search_path = public as $$
  with u as (update public.notifications set emailed_at = now()
             where id = any(p_ids) and emailed_at is null returning 1)
  select count(*)::int from u;
$$;

revoke all on function public.fill_email_due(int) from public, anon, authenticated;
revoke all on function public.mark_fill_emailed(uuid[]) from public, anon, authenticated;
grant execute on function public.fill_email_due(int) to service_role;
grant execute on function public.mark_fill_emailed(uuid[]) to service_role;
