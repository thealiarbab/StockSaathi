-- =============================================================================
-- Chat projects (owner preview): a named group of coach chats with optional
-- instructions Saathi follows in every chat inside it, like ChatGPT projects.
--
-- A chat's project is chat_threads.folder (the project id). This table holds
-- the project itself: name, instructions, and a removed flag (written without
-- DELETE: the Supabase connector cannot run it from an agent session).
-- =============================================================================

create table if not exists public.chat_projects (
  id           text primary key,
  user_id      uuid not null default auth.uid(),
  name         text not null,
  instructions text not null default '',
  removed      boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists chat_projects_user on public.chat_projects (user_id, created_at);
alter table public.chat_projects enable row level security;
revoke all on table public.chat_projects from anon, authenticated;
grant select, insert, update on table public.chat_projects to authenticated;
create policy chat_projects_own on public.chat_projects for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
