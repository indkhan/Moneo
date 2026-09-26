create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  kind text not null check (kind in ('spending_explorer', 'trip_planner', 'goal_tracker')),
  name text not null,
  active_version_id uuid,
  permissions jsonb not null default '[]'::jsonb,
  created_by_conversation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.artifact_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  artifact_id uuid not null references public.artifacts(id),
  version integer not null check (version > 0),
  source text not null,
  manifest jsonb not null,
  status text not null check (status in ('validated', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  constraint artifact_versions_number_unique unique (artifact_id, version)
);

alter table public.artifacts add constraint artifacts_active_version_fk
foreign key (active_version_id) references public.artifact_versions(id);

create table public.artifact_state (
  artifact_id uuid primary key references public.artifacts(id),
  workspace_id uuid not null references public.workspaces(id),
  state jsonb not null default '{}'::jsonb,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);

create table public.dashboard_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  artifact_id uuid not null references public.artifacts(id),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  constraint dashboard_items_artifact_unique unique (workspace_id, artifact_id)
);

alter table public.artifacts enable row level security;
alter table public.artifact_versions enable row level security;
alter table public.artifact_state enable row level security;
alter table public.dashboard_items enable row level security;

create policy own_artifacts on public.artifacts for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id) and (active_version_id is null or exists (
  select 1 from public.artifact_versions where id = active_version_id
    and artifact_id = artifacts.id and workspace_id = artifacts.workspace_id and status = 'validated'
)));

create policy own_artifact_versions on public.artifact_versions for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id) and exists (
  select 1 from public.artifacts where id = artifact_id and workspace_id = artifact_versions.workspace_id
));

create policy own_artifact_state on public.artifact_state for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id) and exists (
  select 1 from public.artifacts where id = artifact_id and workspace_id = artifact_state.workspace_id
));

create policy own_dashboard_items on public.dashboard_items for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id) and exists (
  select 1 from public.artifacts where id = artifact_id and workspace_id = dashboard_items.workspace_id
));

-- Users can pin artifacts and update their local state; trusted versions come from this RPC.
revoke insert, update, delete on public.artifacts, public.artifact_versions from public, authenticated;

create function public.create_trusted_artifact(p_kind text, p_name text)
returns public.artifacts language plpgsql security definer set search_path = '' as $$
declare
  owner_workspace uuid;
  artifact_row public.artifacts%rowtype;
  version_id uuid;
begin
  select id into owner_workspace from public.workspaces where owner_id = auth.uid();
  if owner_workspace is null then
    raise exception 'Workspace unavailable' using errcode = 'P0002';
  end if;
  if p_kind not in ('spending_explorer', 'trip_planner', 'goal_tracker') or
     length(btrim(p_name)) not between 1 and 120 then
    raise exception 'Invalid artifact' using errcode = '22023';
  end if;
  insert into public.artifacts (workspace_id, kind, name, permissions)
  values (owner_workspace, p_kind, btrim(p_name),
    case p_kind
      when 'spending_explorer' then '["spending","cashflow"]'::jsonb
      when 'trip_planner' then '["balances","goals","forecast"]'::jsonb
      else '["goals","balances","forecast"]'::jsonb
    end)
  returning * into artifact_row;
  insert into public.artifact_versions (workspace_id, artifact_id, version, source, manifest, status)
  values (owner_workspace, artifact_row.id, 1, '(input) => ({ kind: input.kind, ready: true })',
    jsonb_build_object('kind', p_kind, 'runtime', 'trusted'), 'validated')
  returning id into version_id;
  insert into public.artifact_state (workspace_id, artifact_id)
  values (owner_workspace, artifact_row.id);
  update public.artifacts set active_version_id = version_id where id = artifact_row.id
  returning * into artifact_row;
  return artifact_row;
end;
$$;

revoke all on function public.create_trusted_artifact(text, text) from public;
grant execute on function public.create_trusted_artifact(text, text) to authenticated;

create function public.rename_trusted_artifact(p_artifact_id uuid, p_name text)
returns public.artifacts language plpgsql security definer set search_path = '' as $$
declare
  artifact_row public.artifacts%rowtype;
  next_version integer;
  version_id uuid;
begin
  if length(btrim(p_name)) not between 1 and 120 then
    raise exception 'Invalid artifact name' using errcode = '22023';
  end if;
  select * into artifact_row from public.artifacts
  where id = p_artifact_id and public.owns_workspace(workspace_id)
  for update;
  if not found then
    raise exception 'Artifact not found' using errcode = 'P0002';
  end if;
  select coalesce(max(version), 0) + 1 into next_version from public.artifact_versions
  where artifact_id = p_artifact_id;
  insert into public.artifact_versions (workspace_id, artifact_id, version, source, manifest, status)
  values (artifact_row.workspace_id, p_artifact_id, next_version, '(input) => ({ kind: input.kind, ready: true })',
    jsonb_build_object('kind', artifact_row.kind, 'runtime', 'trusted'), 'validated')
  returning id into version_id;
  update public.artifacts set name = btrim(p_name), active_version_id = version_id, updated_at = now()
  where id = p_artifact_id returning * into artifact_row;
  return artifact_row;
end;
$$;

revoke all on function public.rename_trusted_artifact(uuid, text) from public;
grant execute on function public.rename_trusted_artifact(uuid, text) to authenticated;
