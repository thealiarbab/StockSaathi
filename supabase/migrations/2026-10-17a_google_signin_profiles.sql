-- Google sign-in: new-user trigger reads Google's name and makes a valid
-- username from the email.
--
-- Google accounts arrive with raw_user_meta_data { full_name, name,
-- avatar_url, email } and no username. The old trigger used the email's local
-- part as-is (it can hold "+", "-" and more than 24 characters) and showed
-- that handle as the display name instead of the person's name.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_chosen        text := nullif(new.raw_user_meta_data->>'username', '');
  v_username      text;
  v_display_name  text;
  v_avatar        text := coalesce(new.raw_user_meta_data->>'avatar_color', 'green');
  v_username_u    text;
  v_try           int := 0;
begin
  -- A username chosen on the signup form was validated there; keep it as
  -- typed. One built from an email (Google sign-in) is cleaned to the same
  -- rules: letters, numbers, underscores and dots, 3 to 24 characters.
  if v_chosen is not null then
    v_username := v_chosen;
  else
    v_username := left(regexp_replace(lower(split_part(new.email, '@', 1)), '[^a-z0-9_.]', '', 'g'), 20);
    if length(v_username) < 3 then v_username := 'saathi' || v_username; end if;
  end if;
  v_display_name := coalesce(
    nullif(new.raw_user_meta_data->>'display_name', ''),
    nullif(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'name', ''),
    v_username);

  v_username_u := v_username;
  while exists (select 1 from public.profiles where lower(username) = lower(v_username_u)) loop
    v_try := v_try + 1;
    v_username_u := v_username || v_try::text;
    exit when v_try > 999;
  end loop;

  insert into public.profiles (id, username, display_name, email, avatar_color)
    values (new.id, v_username_u, v_display_name, new.email, v_avatar);
  insert into public.portfolios (user_id) values (new.id);
  return new;
end;
$function$;
