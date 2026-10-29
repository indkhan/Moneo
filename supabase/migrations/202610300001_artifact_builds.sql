-- One row per artifact build. A build keeps running after the user leaves the page, so this is
-- how they find it again: running, then completed with the saved version, or failed with why.
create table public.artifact_builds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The artifact being changed; for a new artifact, set once it is saved.
  artifact_id uuid references public.artifacts(id) on delete cascade,
  prompt text not null check (length(btrim(prompt)) between 1 and 4000),
  status text not null default 'running' check (status in ('running','completed','failed')),
  version integer check (version >= 1),
  error text check (length(error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index artifact_builds_workspace_created on public.artifact_builds(workspace_id, created_at desc);

alter table public.artifact_builds enable row level security;
create policy own_artifact_builds on public.artifact_builds for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id) and (artifact_id is null or exists (
  select 1 from public.artifacts where id = artifact_id and workspace_id = artifact_builds.workspace_id
)));
grant select, insert on public.artifact_builds to authenticated;
grant update (artifact_id, status, version, error, updated_at) on public.artifact_builds to authenticated;
