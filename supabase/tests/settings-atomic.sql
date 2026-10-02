do $$
declare actor uuid:=gen_random_uuid(); foreign_actor uuid:=gen_random_uuid(); workspace uuid; foreign_workspace uuid; preferences jsonb;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(foreign_actor,'qa-'||foreign_actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  select id into strict foreign_workspace from public.workspaces where owner_id=foreign_actor;
  preferences:='{"timezone":"Europe/Berlin","locale":"en-GB","theme":"dark","openrouter_model":null,"ai_data_scopes":["accounts"],"muted_insight_types":[],"summary_cadence":"none","summary_time":"09:00"}';
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  perform public.save_workspace_preferences(workspace,'USD',preferences);
  if not exists(select 1 from public.workspaces where id=workspace and display_currency='USD')
    or not exists(select 1 from public.workspace_settings where workspace_id=workspace and theme='dark') then raise exception 'Atomic preferences failed to persist'; end if;
  begin
    perform public.save_workspace_preferences(workspace,'EUR',jsonb_set(preferences,'{theme}','"invalid"'));
    raise exception 'Invalid settings persisted' using errcode='ZX001';
  exception when check_violation then null; end;
  if not exists(select 1 from public.workspaces where id=workspace and display_currency='USD') then raise exception 'Currency changed despite failed preferences'; end if;
  begin
    perform public.save_workspace_preferences(foreign_workspace,'EUR',preferences);
    raise exception 'Foreign preferences allowed' using errcode='ZX001';
  exception when sqlstate 'P0002' then null; end;
  execute 'reset role';
end;
$$;
