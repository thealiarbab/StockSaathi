-- 2026-09-13c — Drop coach_chats now that its contents live in coach_messages.
--
-- Run only after 2026-09-13b. Verified before dropping:
--   * 28 rows migrated (2 users, 4 sessions), matching the source exactly
--   * the user who had NO chat rows in coach_messages now has 8
--   * the leaked ADMIN_PATH value occurs 0 times in coach_messages,
--     ai_response_cache or admin_audit_log
--   * no live code reads or writes coach_chats — the only remaining mentions
--     are comments in js/db/sync.js describing the v142 retirement
--
-- Dropping also destroys the last stored copy of the pasted ADMIN_PATH value.
-- That secret still needs rotating: it was sent to an LLM provider when the
-- message was first answered. This only removes it from our own storage.

drop table if exists public.coach_chats;
