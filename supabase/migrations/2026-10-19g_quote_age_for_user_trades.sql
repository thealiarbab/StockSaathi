-- A market order placed by a user books quote_cache only if our server
-- refreshed it in the last 60 s (was 5 min). The browser no longer forces a
-- Yahoo fetch before every order (it takes the price the page holds when
-- that is under 20 s old), so the server owns the freshness rule. The order
-- matcher (service role: auth.uid() is null) keeps the 5-minute window.
create or replace function public._quote_not_live_reason(p_symbol text)
returns text language plpgsql stable security definer set search_path to 'public' as $function$
declare
  v_src text; v_ts bigint; v_cached bigint;
  v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  v_open_ms bigint := (extract(epoch from
      ((now() at time zone 'Asia/Kolkata')::date + time '09:15') at time zone 'Asia/Kolkata') * 1000)::bigint;
  v_max_age_ms bigint := case when auth.uid() is null then 5 * 60 * 1000 else 60 * 1000 end;
begin
  select source, ts_ms, cached_at_ms into v_src, v_ts, v_cached
    from public.quote_cache where symbol = p_symbol;
  if not found then return 'no price'; end if;
  if v_src = 'nse_eod' then return 'only the exchange''s previous close is available'; end if;
  if coalesce(v_ts, 0) < v_open_ms then return 'it has not traded yet today'; end if;
  if coalesce(v_cached, 0) < v_now_ms - v_max_age_ms then
    return case when auth.uid() is null then 'the price is more than 5 minutes old' else 'the price is more than a minute old' end;
  end if;
  return null;
end;
$function$;
