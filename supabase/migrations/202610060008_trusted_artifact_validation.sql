-- MNE-039: only the trusted server validator may assert a generated result.
-- Its actor comes from requireWorkspace; ownership and current permissions are
-- rechecked under the same artifact lock as CAS. No client validation assertion.
create function public.save_validated_generated_artifact_version(p_artifact_id uuid,p_actor_id uuid,p_source text,p_manifest jsonb,p_status text,p_error text,p_expected_active_version_id uuid)
returns public.artifact_versions language plpgsql security definer set search_path='' as $$
declare artifact_row public.artifacts%rowtype; next_version integer; version_row public.artifact_versions%rowtype; sdk_item jsonb;
begin
  if p_actor_id is null then raise exception 'Verified actor required' using errcode='28000'; end if;
  if p_status is null or p_status not in ('validated','failed') or p_source is null or length(p_source) not between 1 and 8000 then
    raise exception 'Invalid candidate source or status' using errcode='22023'; end if;
  if p_manifest is null or jsonb_typeof(p_manifest)<>'object' or jsonb_typeof(p_manifest->'kind') is distinct from 'string'
    or p_manifest->>'runtime' is distinct from 'quickjs-calculator-v1' or jsonb_typeof(p_manifest->'sdk') is distinct from 'array' then
    raise exception 'Invalid calculator manifest' using errcode='22023'; end if;
  select a.* into artifact_row from public.artifacts a
    join public.workspaces w on w.id=a.workspace_id
    where a.id=p_artifact_id and w.owner_id=p_actor_id for update of a;
  if not found then raise exception 'Artifact not found' using errcode='P0002'; end if;
  if p_status='validated' and artifact_row.active_version_id is distinct from p_expected_active_version_id then
    raise exception 'Active version changed' using errcode='40001';
  end if;
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

revoke all on function public.save_validated_generated_artifact_version(uuid,uuid,text,jsonb,text,text,uuid)
  from public,anon,authenticated;
grant execute on function public.save_validated_generated_artifact_version(uuid,uuid,text,jsonb,text,text,uuid) to service_role;

-- Close every existing generated-save overload, including the legacy non-CAS one.
revoke all on function public.save_generated_artifact_version(uuid,text,jsonb,text,text),
  public.save_generated_artifact_version(uuid,text,jsonb,text,text,uuid)
  from public,anon,authenticated,service_role;
