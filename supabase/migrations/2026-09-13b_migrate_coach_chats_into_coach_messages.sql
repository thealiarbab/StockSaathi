-- 2026-09-13b — Fold coach_chats into coach_messages, redacting a leaked secret.
--
-- coach_chats was the v138 per-user blob table. v142 made coach_messages the
-- single source of truth (js/db/sync.js:355) but the 2 remaining rows were
-- never migrated, so they sat orphaned for five months.
--
-- Verified before running:
--   * none of the 28 messages already existed in coach_messages (matched on
--     user_id + event_type + created_at within 2s), so this cannot duplicate
--     history. Notably the owning user had 86 chat rows in coach_messages
--     already — none of them these. The two write paths had diverged.
--   * one of the two users had NO chat rows in coach_messages at all. His
--     conversation existed only in coach_chats, which is why that table was
--     not simply dropped.
--
-- The ADMIN_PATH value a user pasted into chat is replaced rather than carried
-- across. It occurred exactly once, as the entire text of one message. A scan
-- of all 430 chat rows for other secret-shaped strings (JWTs, sk-*, AIza*,
-- long opaque tokens) found nothing else.

insert into public.coach_messages (user_id, event_type, payload, session_id, surface, created_at)
select
  cc.user_id,
  case when m->>'role' = 'user' then 'chat_user' else 'chat_assistant' end,
  jsonb_build_object(
    'text',
    case when m->>'text' like '%xCogW9B6Qv70%'
         then '[redacted 2026-09-13 — admin path value removed]'
         else m->>'text' end,
    'migrated_from', 'coach_chats'
  ),
  s->>'id',
  'chat_page',
  to_timestamp((m->>'ts')::bigint / 1000.0)
from public.coach_chats cc
cross join lateral jsonb_array_elements(coalesce(cc.sessions_json->'sessions','[]'::jsonb)) s
cross join lateral jsonb_array_elements(coalesce(s->'messages','[]'::jsonb)) m
where not exists (
  select 1 from public.coach_messages cm
  where cm.user_id = cc.user_id
    and cm.event_type = (case when m->>'role' = 'user' then 'chat_user' else 'chat_assistant' end)
    and abs(extract(epoch from (cm.created_at - to_timestamp((m->>'ts')::bigint / 1000.0)))) < 2
);
