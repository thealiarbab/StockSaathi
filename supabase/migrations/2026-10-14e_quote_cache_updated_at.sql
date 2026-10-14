-- DI3: quote_cache.updated_at stayed at the row's first insert (TCS read
-- 20 Apr while holding today's price); only cached_at_ms moved. Any refresh
-- that does not set updated_at itself now stamps it.
create or replace function public._quote_cache_touch()
returns trigger language plpgsql as $$
begin
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists quote_cache_touch on public.quote_cache;
create trigger quote_cache_touch before update on public.quote_cache
  for each row execute function public._quote_cache_touch();

-- Existing rows: the real refresh time is cached_at_ms.
update public.quote_cache
   set updated_at = to_timestamp(cached_at_ms / 1000.0)
 where cached_at_ms is not null
   and updated_at < to_timestamp(cached_at_ms / 1000.0);
