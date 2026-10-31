-- Ops alert delivery (31 Oct 2026, owner's call).
--  * E-mail goes to ali@aliarbab2009.com only, once per alert (the trigger
--    fires for each owner row; it now sends on the main owner's row only).
--  * Ops alerts skip the 22:00-07:00 IST push hold: an attack at 1 am must
--    not wait for the 07:05 flush. Everything else is held as before.

create or replace function public._ops_alert_mail()
 returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.user_id <> '63aee5be-4eaa-409d-9c1e-f60c4daa5823'::uuid then
    return new;
  end if;
  perform net.http_post(
    url := 'https://stocksaathi.co.in/api/ai?op=ops-mail',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := jsonb_build_object('to', 'ali@aliarbab2009.com', 'title', new.title, 'body', new.body),
    timeout_milliseconds := 10000);
  return new;
exception when others then
  return new;
end $$;
revoke all on function public._ops_alert_mail() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public._notification_push()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.push_subscriptions s
     WHERE s.user_id = NEW.user_id
       AND NOT s.disabled
       AND NEW.category = ANY(s.categories)
  ) THEN
    RETURN NEW;
  END IF;

  IF public._ist_quiet_hours() AND NEW.kind <> 'ops_alert' THEN
    UPDATE public.notifications SET push_state = 'deferred' WHERE id = NEW.id;
  ELSE
    UPDATE public.notifications SET push_state = 'pending' WHERE id = NEW.id;

    -- Daily recaps are inserted as a large batch. Enqueuing one HTTP request
    -- per row overloads the Edge Function gateway; send them via one flush
    -- at the end of send_daily_recap() instead.
    IF NEW.kind <> 'daily_recap' THEN
      PERFORM public._push_poke(jsonb_build_object('id', NEW.id));
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
