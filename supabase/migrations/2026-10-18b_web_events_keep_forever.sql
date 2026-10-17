-- Raw web_events are kept forever (owner's decision, 18 Oct 2026): the
-- nightly job only adds daily totals; the 600k-row cap is gone. user_events
-- was never pruned. Watch database size on the Supabase plan.
create or replace function public.roll_up_web_events(p_days integer default 2)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  insert into web_event_daily (day, kind, path, target, n, visitors)
  select (ts at time zone 'Asia/Kolkata')::date, kind, web_path_group(path),
         left(coalesce(target, ''), 200), count(*), count(distinct vid)
    from web_events
   where ts >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' - make_interval(days => p_days - 1)
   group by 1, 2, 3, 4
  on conflict (day, kind, path, target) do update set n = excluded.n, visitors = excluded.visitors;
  get diagnostics n = row_count;
  return n;
end $$;
