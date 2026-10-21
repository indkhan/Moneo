-- Artifacts: AI-built interactive pages. Each change appends an immutable version; the page
-- itself only renders data the app computes from the version's saved read-only queries.
create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index artifacts_workspace_live on public.artifacts(workspace_id, updated_at desc) where deleted_at is null;

create table public.artifact_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  artifact_id uuid not null references public.artifacts(id) on delete cascade,
  version integer not null check (version >= 1),
  prompt text not null check (length(btrim(prompt)) between 1 and 4000),
  html text not null check (length(html) between 1 and 200000),
  queries jsonb not null default '[]'::jsonb check (jsonb_typeof(queries) = 'array'),
  model text,
  created_at timestamptz not null default now(),
  unique (artifact_id, version)
);

alter table public.artifacts enable row level security;
alter table public.artifact_versions enable row level security;
create policy own_artifacts on public.artifacts for all to authenticated
using (public.owns_workspace(workspace_id)) with check (public.owns_workspace(workspace_id));
create policy own_artifact_versions on public.artifact_versions for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id) and exists (
  select 1 from public.artifacts where id = artifact_id and workspace_id = artifact_versions.workspace_id
));

-- Versions are append-only history; artifacts are renamed, touched or soft-deleted.
grant select, insert on public.artifacts, public.artifact_versions to authenticated;
grant update (title, updated_at, deleted_at) on public.artifacts to authenticated;
