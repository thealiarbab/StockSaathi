-- =============================================================================
-- Owner previews + ChatGPT-style chat storage.
--
-- admin_users / is_admin(): accounts that see features before everyone else.
-- A separate table, not a profiles column: users can update their own
-- profiles row, so a column there would let anyone make themselves admin.
-- is_admin() also pins the two owner ids, so a row added by mistake grants
-- nothing (one was, for a few minutes on 19 Oct; it is marked inactive).
--
-- chat_threads: one row per conversation, the whole message tree as a JSON
-- document. coach_messages keeps one flat line of turns, which cannot hold an
-- edited question or a regenerated answer: the chat page rebuilt from it
-- would undo every edit on the next visit. coach_messages is still written
-- per turn (admin analytics); chat_threads is what the chat page reads.
--   doc: {"messages": [{role, text, ts, ..., vers?: [[msg, ...tail], ...], vi?}]}
--   A message with `vers` is a branch point: each entry is an alternative
--   from that message to the end; `vi` is the one on screen.
-- chat_shares: a public, read-only snapshot of one conversation (the branch
--   on screen when shared), refreshable and revocable, like ChatGPT's shared
--   links. Read through get_shared_chat() only.
-- chat_feedback: thumbs up/down on a reply, with an optional reason.
--
-- Written without DROP / DELETE: the Supabase connector waits for a
-- confirmation on those that never reaches an agent session.
-- =============================================================================

create table if not exists public.admin_users (
  user_id    uuid primary key,
  note       text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;
revoke all on table public.admin_users from anon, authenticated;
grant select on table public.admin_users to authenticated;
create policy admin_users_self_read on public.admin_users for select to authenticated using (user_id = auth.uid());

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path to 'public'
as $$ select auth.uid() in ('63aee5be-4eaa-409d-9c1e-f60c4daa5823'::uuid, '73c89104-24ab-47c0-9c71-5fe7c82323dc'::uuid)
          and exists (select 1 from public.admin_users where user_id = auth.uid()); $$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

insert into public.admin_users (user_id, note) values
  ('63aee5be-4eaa-409d-9c1e-f60c4daa5823', 'owner: aliarbab2009'),
  ('73c89104-24ab-47c0-9c71-5fe7c82323dc', 'owner: admin / business@stocksaathi.co.in')
on conflict (user_id) do nothing;

create table if not exists public.chat_threads (
  id          text primary key,
  user_id     uuid not null default auth.uid(),
  title       text not null default 'New chat',
  pinned      boolean not null default false,
  archived    boolean not null default false,
  trashed     boolean not null default false,
  folder      text,
  doc         jsonb not null default '{"messages": []}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists chat_threads_user_updated on public.chat_threads (user_id, updated_at desc);
alter table public.chat_threads enable row level security;
revoke all on table public.chat_threads from anon, authenticated;
grant select, insert, update on table public.chat_threads to authenticated;
create policy chat_threads_own on public.chat_threads for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.chat_shares (
  id           text primary key default replace(gen_random_uuid()::text, '-', ''),
  user_id      uuid not null default auth.uid(),
  thread_id    text not null,
  title        text not null,
  messages     jsonb not null,
  hide_amounts boolean not null default false,
  revoked      boolean not null default false,
  views        integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists chat_shares_user on public.chat_shares (user_id, created_at desc);
alter table public.chat_shares enable row level security;
revoke all on table public.chat_shares from anon, authenticated;
grant select, insert, update on table public.chat_shares to authenticated;
create policy chat_shares_own on public.chat_shares for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.get_shared_chat(p_id text) returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare r public.chat_shares;
begin
  select * into r from public.chat_shares where id = p_id and not revoked;
  if not found then return null; end if;
  update public.chat_shares set views = views + 1 where id = p_id;
  return jsonb_build_object('id', r.id, 'title', r.title, 'messages', r.messages,
    'created_at', r.created_at, 'updated_at', r.updated_at,
    'author', (select coalesce(nullif(display_name, ''), username) from public.profiles where id = r.user_id));
end;
$$;
grant execute on function public.get_shared_chat(text) to anon, authenticated;

create table if not exists public.chat_feedback (
  id         bigserial primary key,
  user_id    uuid not null default auth.uid(),
  thread_id  text,
  msg_ts     bigint,
  rating     smallint not null check (rating in (-1, 1)),
  reason     text,
  reply      text,
  created_at timestamptz not null default now()
);
alter table public.chat_feedback enable row level security;
revoke all on table public.chat_feedback from anon, authenticated;
grant select, insert on table public.chat_feedback to authenticated;
grant usage on sequence public.chat_feedback_id_seq to authenticated;
create policy chat_feedback_own on public.chat_feedback for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
