-- Persisted owner preferences, database allowlists and real authenticated isolation.
do $$
declare actor uuid:=gen_random_uuid(); foreign_actor uuid:=gen_random_uuid(); workspace uuid; foreign_workspace uuid;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(foreign_actor,'qa-'||foreign_actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  select id into strict foreign_workspace from public.workspaces where owner_id=foreign_actor;
  insert into public.workspace_settings(workspace_id,theme) values(foreign_workspace,'dark');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  insert into public.workspace_settings(workspace_id,timezone,locale,theme,ai_data_scopes)
    values(workspace,'America/New_York','en-US','light',array['accounts']);
  if not exists(select 1 from public.workspace_settings where workspace_id=workspace and timezone='America/New_York' and ai_data_scopes=array['accounts']) then raise exception 'Preferences failed to persist'; end if;
  if exists(select 1 from public.workspace_settings where workspace_id=foreign_workspace) then raise exception 'Foreign settings visible'; end if;
  begin
    update public.workspace_settings set ai_data_scopes=array['secrets'] where workspace_id=workspace;
    raise exception 'Unallowlisted provider scope accepted' using errcode='ZX001';
  exception when check_violation then null; end;
  begin
    insert into public.workspace_settings(workspace_id,theme) values(foreign_workspace,'light');
    raise exception 'Foreign settings write allowed' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  update public.workspace_settings set theme='dark',summary_cadence='weekly',summary_time='08:15' where workspace_id=workspace;
  if not exists(select 1 from public.workspace_settings where workspace_id=workspace and theme='dark' and summary_time='08:15') then raise exception 'Settings update unavailable'; end if;
  execute 'reset role';
end;
$$;
