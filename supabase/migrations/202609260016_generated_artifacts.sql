-- Generated calculator versions (§35-40 smallest safe path).
-- No table changes (schema.ts stays untouched). Adds one SECURITY DEFINER
-- RPC so the server can persist AI-generated candidates as new versions.
-- A failed candidate is stored with status='failed' and NEVER becomes the
-- active version; the prior active version and artifact_state are preserved.

create function public.save_generated_artifact_version(
  p_artifact_id uuid,
  p_source text,
  p_manifest jsonb,
  p_status text,
  p_error text
)
returns public.artifact_versions language plpgsql security definer set search_path = '' as $$
declare
  artifact_row public.artifacts%rowtype;
  next_version integer;
  version_row public.artifact_versions%rowtype;
  manifest_kind text;
  manifest_runtime text;
  sdk_item text;
  artifact_perms jsonb;
begin
  if p_status not in ('validated', 'failed') then
    raise exception 'Invalid version status' using errcode = '22023';
  end if;
  if p_source is null or length(p_source) = 0 or length(p_source) > 8000 then
    raise exception 'Invalid source length' using errcode = '22023';
  end if;
  if p_manifest is null or (p_manifest ->> 'kind') is null or (p_manifest ->> 'runtime') is null then
    raise exception 'Invalid manifest' using errcode = '22023';
  end if;
  manifest_kind := p_manifest ->> 'kind';
  manifest_runtime := p_manifest ->> 'runtime';
  if manifest_runtime <> 'quickjs-calculator-v1' then
    raise exception 'Unsupported calculator runtime' using errcode = '22023';
  end if;

  select * into artifact_row from public.artifacts
  where id = p_artifact_id and public.owns_workspace(workspace_id)
  for update;
  if not found then
    raise exception 'Artifact not found' using errcode = 'P0002';
  end if;
  if manifest_kind <> artifact_row.kind then
    raise exception 'Manifest kind does not match artifact' using errcode = '22023';
  end if;

  -- Manifest sdk must be a subset of the artifact permissions. The host
  -- injects snapshots only for these operations; generated code never
  -- receives DB handles.
  artifact_perms := coalesce(artifact_row.permissions, '[]'::jsonb);
  if jsonb_typeof(p_manifest -> 'sdk') = 'array' then
    for sdk_item in select jsonb_array_elements_text(p_manifest -> 'sdk') loop
      if not (artifact_perms ? sdk_item) and not (
        (artifact_row.kind = 'spending_explorer' and sdk_item in ('spending', 'cashflow')) or
        (artifact_row.kind = 'trip_planner' and sdk_item in ('balances', 'goals', 'forecast')) or
        (artifact_row.kind = 'goal_tracker' and sdk_item in ('goals', 'balances', 'forecast'))
      ) then
        raise exception 'Unauthorized SDK operation: %', sdk_item using errcode = '42501';
      end if;
    end loop;
  end if;

  select coalesce(max(version), 0) + 1 into next_version from public.artifact_versions
  where artifact_id = p_artifact_id;

  insert into public.artifact_versions (workspace_id, artifact_id, version, source, manifest, status, error)
  values (artifact_row.workspace_id, p_artifact_id, next_version, p_source, p_manifest, p_status,
    case when p_status = 'failed' then coalesce(nullif(p_error, ''), 'Validation failed') else null end)
  returning * into version_row;

  -- Only a validated candidate becomes active. Failed candidates preserve
  -- the prior active version and leave artifact_state untouched.
  if p_status = 'validated' then
    update public.artifacts set active_version_id = version_row.id, updated_at = now()
    where id = p_artifact_id;
  end if;

  return version_row;
end;
$$;

revoke all on function public.save_generated_artifact_version(uuid, text, jsonb, text, text) from public;
grant execute on function public.save_generated_artifact_version(uuid, text, jsonb, text, text) to authenticated;
