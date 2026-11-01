-- Artifacts are now built in their own chat (a conversation linked to the artifact), so the separate build
-- tracker goes; the chat's requests already record running, finished and failed work.
drop table public.artifact_builds;

-- Composite keys keep every link inside one workspace.
alter table public.artifacts add constraint artifacts_id_workspace_key unique (id, workspace_id);

alter table public.conversations add column artifact_id uuid;
alter table public.conversations add constraint conversations_artifact_fkey
  foreign key (artifact_id, workspace_id) references public.artifacts(id, workspace_id) on delete cascade;
create unique index conversations_artifact on public.conversations(artifact_id) where artifact_id is not null;

-- Home cards made from an artifact. A card is stable (its place on Home points at it); each change appends an
-- immutable version, and Home shows only the published one, so a draft never changes Home on its own.
create table public.artifact_cards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  artifact_id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 80),
  size text not null default 'M' check (size in ('S','M','L','XL')),
  published_version integer check (published_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (id, workspace_id),
  foreign key (artifact_id, workspace_id) references public.artifacts(id, workspace_id) on delete cascade
);
create index artifact_cards_artifact on public.artifact_cards(artifact_id, created_at) where deleted_at is null;

create table public.artifact_card_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  card_id uuid not null,
  version integer not null check (version >= 1),
  -- preset: our own template filled with the model's settings; code: React the designer model wrote.
  kind text not null check (kind in ('preset','code')),
  preset text,
  source text not null check (length(source) between 1 and 200000),
  compiled text not null check (length(compiled) between 1 and 400000),
  queries jsonb not null default '[]'::jsonb check (jsonb_typeof(queries) = 'array'),
  params jsonb not null default '[]'::jsonb check (jsonb_typeof(params) = 'array'),
  prompt text not null check (length(btrim(prompt)) between 1 and 4000),
  model text,
  created_at timestamptz not null default now(),
  unique (card_id, version),
  foreign key (card_id, workspace_id) references public.artifact_cards(id, workspace_id) on delete cascade
);

alter table public.artifact_cards enable row level security;
alter table public.artifact_card_versions enable row level security;
create policy own_artifact_cards on public.artifact_cards for all to authenticated
using (public.owns_workspace(workspace_id)) with check (public.owns_workspace(workspace_id));
create policy own_artifact_card_versions on public.artifact_card_versions for all to authenticated
using (public.owns_workspace(workspace_id)) with check (public.owns_workspace(workspace_id));

-- Versions are append-only history; cards are renamed, resized, published or soft-deleted.
grant select, insert on public.artifact_cards, public.artifact_card_versions to authenticated;
grant update (title, size, published_version, updated_at, deleted_at) on public.artifact_cards to authenticated;
