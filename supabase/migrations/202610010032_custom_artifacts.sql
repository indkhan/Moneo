alter table public.artifacts drop constraint artifacts_kind_check;
alter table public.artifacts add constraint artifacts_kind_check check(kind in
  ('spending_explorer','trip_planner','goal_tracker','custom_planner','custom_tracker','custom_report','custom_comparison'));

create or replace function public.create_trusted_artifact(p_kind text,p_name text)
returns public.artifacts language plpgsql security definer set search_path='' as $$
declare owner_workspace uuid; artifact_row public.artifacts%rowtype; version_id uuid; custom boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select id into owner_workspace from public.workspaces where owner_id=auth.uid();
  if owner_workspace is null then raise exception 'Workspace unavailable' using errcode='P0002'; end if;
  if p_kind is null or p_kind not in ('spending_explorer','trip_planner','goal_tracker','custom_planner','custom_tracker','custom_report','custom_comparison')
    or p_name is null or length(btrim(p_name)) not between 1 and 120 then raise exception 'Invalid artifact' using errcode='22023'; end if;
  custom:=p_kind like 'custom_%';
  insert into public.artifacts(workspace_id,kind,name,permissions)
    values(owner_workspace,p_kind,btrim(p_name),case
      when custom then '["spending","cashflow","balances","goals","forecast"]'::jsonb
      when p_kind='spending_explorer' then '["spending","cashflow"]'::jsonb
      else '["balances","goals","forecast"]'::jsonb end) returning * into artifact_row;
  insert into public.artifact_versions(workspace_id,artifact_id,version,source,manifest,status)
    values(owner_workspace,artifact_row.id,1,case when custom then '(input) => ({ summary: "Create a reviewed calculator for this tool", rows: [] })'
      else '(input) => ({ kind: input.kind, ready: true })' end,
      jsonb_build_object('kind',p_kind,'runtime','trusted','sdk','[]'::jsonb,'params','{}'::jsonb,'renderer','trusted'),'validated') returning id into version_id;
  insert into public.artifact_state(workspace_id,artifact_id) values(owner_workspace,artifact_row.id);
  update public.artifacts set active_version_id=version_id where id=artifact_row.id returning * into artifact_row;
  return artifact_row;
end;
$$;

create or replace function public.save_generated_artifact_version(p_artifact_id uuid,p_source text,p_manifest jsonb,p_status text,p_error text)
returns public.artifact_versions language plpgsql security definer set search_path='' as $$
declare artifact_row public.artifacts%rowtype; next_version integer; version_row public.artifact_versions%rowtype; sdk_item jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_status is null or p_status not in ('validated','failed') or p_source is null or length(p_source) not between 1 and 8000 then
    raise exception 'Invalid candidate source or status' using errcode='22023'; end if;
  if p_manifest is null or jsonb_typeof(p_manifest)<>'object' or jsonb_typeof(p_manifest->'kind') is distinct from 'string'
    or p_manifest->>'runtime' is distinct from 'quickjs-calculator-v1' or jsonb_typeof(p_manifest->'sdk') is distinct from 'array' then
    raise exception 'Invalid calculator manifest' using errcode='22023'; end if;
  select * into artifact_row from public.artifacts where id=p_artifact_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Artifact not found' using errcode='P0002'; end if;
  if p_manifest->>'kind' is distinct from artifact_row.kind then raise exception 'Manifest kind does not match artifact' using errcode='22023'; end if;
  for sdk_item in select value from jsonb_array_elements(p_manifest->'sdk') loop
    if jsonb_typeof(sdk_item)<>'string' or (sdk_item #>> '{}') not in ('spending','cashflow','balances','goals','forecast')
      or (artifact_row.kind='spending_explorer' and (sdk_item #>> '{}') not in ('spending','cashflow'))
      or (artifact_row.kind in ('trip_planner','goal_tracker') and (sdk_item #>> '{}') not in ('balances','goals','forecast'))
      or jsonb_typeof(artifact_row.permissions)<>'array' or not(artifact_row.permissions ? (sdk_item #>> '{}')) then
      raise exception 'Unauthorized SDK operation' using errcode='42501'; end if;
  end loop;
  select coalesce(max(version),0)+1 into next_version from public.artifact_versions where artifact_id=p_artifact_id;
  insert into public.artifact_versions(workspace_id,artifact_id,version,source,manifest,status,error)
    values(artifact_row.workspace_id,p_artifact_id,next_version,p_source,p_manifest,p_status,case when p_status='failed' then coalesce(nullif(p_error,''),'Validation failed') end)
    returning * into version_row;
  if p_status='validated' then update public.artifacts set active_version_id=version_row.id,updated_at=now() where id=p_artifact_id; end if;
  return version_row;
end;
$$;
revoke all on function public.create_trusted_artifact(text,text),public.save_generated_artifact_version(uuid,text,jsonb,text,text) from public,anon;
grant execute on function public.create_trusted_artifact(text,text),public.save_generated_artifact_version(uuid,text,jsonb,text,text) to authenticated;

-- Renaming versions the name while preserving the active reviewed calculator and its state.
create or replace function public.rename_trusted_artifact(p_artifact_id uuid,p_name text)
returns public.artifacts language plpgsql security definer set search_path='' as $$
declare artifact_row public.artifacts%rowtype; active public.artifact_versions%rowtype; next_version integer; version_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 120 then raise exception 'Invalid artifact name' using errcode='22023'; end if;
  select * into artifact_row from public.artifacts where id=p_artifact_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Artifact not found' using errcode='P0002'; end if;
  select * into active from public.artifact_versions where id=artifact_row.active_version_id and artifact_id=artifact_row.id
    and workspace_id=artifact_row.workspace_id and status='validated';
  if not found then raise exception 'Active reviewed artifact version is unavailable' using errcode='P0002'; end if;
  select coalesce(max(version),0)+1 into next_version from public.artifact_versions where artifact_id=p_artifact_id;
  insert into public.artifact_versions(workspace_id,artifact_id,version,source,manifest,status)
    values(artifact_row.workspace_id,p_artifact_id,next_version,active.source,active.manifest,'validated') returning id into version_id;
  update public.artifacts set name=btrim(p_name),active_version_id=version_id,updated_at=now() where id=p_artifact_id returning * into artifact_row;
  return artifact_row;
end;
$$;
revoke all on function public.rename_trusted_artifact(uuid,text) from public,anon;
grant execute on function public.rename_trusted_artifact(uuid,text) to authenticated;
