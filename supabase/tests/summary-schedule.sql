do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; period date; first_job uuid; repeated uuid;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.workspace_settings(workspace_id,timezone,summary_cadence,summary_time) values(workspace,'Europe/Berlin','weekly','00:00');
  period:=date_trunc('week',now() at time zone 'Europe/Berlin')::date;
  execute 'set local role service_role';
  first_job:=public.claim_scheduled_summary(workspace,'weekly',period);
  repeated:=public.claim_scheduled_summary(workspace,'weekly',period);
  if first_job is null or repeated is not null then raise exception 'Scheduled claim must create exactly one job'; end if;
  if (select count(*) from public.summary_runs where workspace_id=workspace)<>1 then raise exception 'Scheduled receipt duplicated'; end if;
  execute 'reset role';
  update public.workspace_settings set summary_cadence='none' where workspace_id=workspace;
  execute 'set local role service_role';
  if public.claim_scheduled_summary(workspace,'weekly',period) is not null then raise exception 'Disabled schedule claimed'; end if;
  execute 'reset role';
  update public.workspace_settings set summary_cadence='monthly',ai_data_scopes=array['accounts'] where workspace_id=workspace;
  execute 'set local role service_role';
  if public.claim_scheduled_summary(workspace,'monthly',date_trunc('month',now() at time zone 'Europe/Berlin')::date) is not null then raise exception 'Revoked transaction scope scheduled'; end if;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  if not exists(select 1 from public.summary_runs where workspace_id=workspace and job_id=first_job) then raise exception 'Own schedule receipt unavailable'; end if;
  begin
    perform public.claim_scheduled_summary(workspace,'weekly',period);
    raise exception 'Authenticated caller claimed privileged scheduler' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
end;
$$;
