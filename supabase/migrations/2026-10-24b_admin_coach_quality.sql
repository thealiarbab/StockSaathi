-- /a "Coach quality": per IST day, questions asked, thumbs up/down,
-- regenerate / edit taps (web_events kind 'coach', from 2026-10-24), and how
-- each /api/chat call ended (llm_usage, from 2026-10-23). Haiku became the
-- lead model on ~2026-10-20; days before that are Gemini.

create or replace function public.admin_coach_quality(p_days int default 30)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with since as (select now() - make_interval(days => least(greatest(p_days, 1), 120)) as t),
  q as (
    select (created_at at time zone 'Asia/Kolkata')::date as day,
           count(*) filter (where surface = 'chat_page') as asked_chat_page,
           count(*) filter (where surface = 'side_panel') as asked_side_panel,
           count(distinct user_id) as askers
    from public.coach_messages, since
    where event_type = 'chat_user' and created_at >= since.t group by 1
  ),
  fb as (
    select (created_at at time zone 'Asia/Kolkata')::date as day,
           count(*) filter (where rating > 0) as up, count(*) filter (where rating < 0) as down
    from public.chat_feedback, since where created_at >= since.t group by 1
  ),
  taps as (
    select (ts at time zone 'Asia/Kolkata')::date as day,
           count(*) filter (where target = 'regenerate') as regenerate,
           count(*) filter (where target = 'edit') as edit
    from public.web_events, since where kind = 'coach' and ts >= since.t group by 1
  ),
  calls as (
    select (ts at time zone 'Asia/Kolkata')::date as day,
           count(*) filter (where ok and upstream = 'messages') as answered_haiku,
           count(*) filter (where ok and upstream like 'gemini%') as answered_gemini,
           count(*) filter (where not ok) as failed_attempts,
           count(*) filter (where status = 'refusal') as refusals,
           count(*) filter (where ok and stop_reason in ('max_tokens', 'length')) as cut_off,
           percentile_disc(0.5) within group (order by ttft_ms) filter (where ok) as p50_first_token_ms,
           percentile_disc(0.9) within group (order by ttft_ms) filter (where ok) as p90_first_token_ms
    from public.llm_usage, since where route = 'chat' and ts >= since.t group by 1
  ),
  days as (
    select day from q union select day from fb union select day from taps union select day from calls
  )
  select jsonb_build_object(
    'days', coalesce((select jsonb_agg(jsonb_build_object(
        'day', d.day,
        'asked_chat_page', coalesce(q.asked_chat_page, 0), 'asked_side_panel', coalesce(q.asked_side_panel, 0),
        'askers', coalesce(q.askers, 0),
        'up', coalesce(fb.up, 0), 'down', coalesce(fb.down, 0),
        'regenerate', coalesce(taps.regenerate, 0), 'edit', coalesce(taps.edit, 0),
        'answered_haiku', calls.answered_haiku, 'answered_gemini', calls.answered_gemini,
        'failed_attempts', calls.failed_attempts, 'refusals', calls.refusals, 'cut_off', calls.cut_off,
        'p50_first_token_ms', calls.p50_first_token_ms, 'p90_first_token_ms', calls.p90_first_token_ms
      ) order by d.day desc)
      from days d left join q using (day) left join fb using (day) left join taps using (day) left join calls using (day)), '[]'::jsonb),
    'recent_down', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select created_at, thread_id = 'side_panel' as pop_up, reason, left(reply, 300) as reply
        from public.chat_feedback, since where rating < 0 and created_at >= since.t
        order by created_at desc limit 20) x), '[]'::jsonb)
  );
$$;
revoke all on function public.admin_coach_quality(int) from public, anon, authenticated;
grant execute on function public.admin_coach_quality(int) to service_role;
