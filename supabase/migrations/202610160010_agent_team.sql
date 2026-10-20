-- Agent team: a durable run of specialised agents that analyse the workspace after an import.
-- Agents only PROPOSE. Proposals change nothing canonical; accepting one calls the existing
-- audited RPCs as the signed-in user, so history and Undo keep working.
create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  import_id uuid references public.imports(id) on delete set null,
  trigger text not null default 'manual',
  status text not null default 'queued',
  cancel_requested boolean not null default false,
  workflow_run_id text,
  plan jsonb not null default '[]'::jsonb,
  briefing text,
  model_calls integer not null default 0,
  model_budget integer not null default 6,
  model_status text not null default 'unknown',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint agent_runs_trigger_check check (trigger in ('import','manual')),
  constraint agent_runs_status_check check (status in ('queued','running','completed','failed','canceled')),
  constraint agent_runs_model_status_check check (model_status in ('unknown','available','unavailable','budget_exhausted','disabled')),
  constraint agent_runs_budget_check check (model_budget between 0 and 20 and model_calls between 0 and model_budget),
  constraint agent_runs_plan_check check (jsonb_typeof(plan)='array')
);
create unique index agent_runs_import_unique on public.agent_runs(import_id) where import_id is not null;
create index agent_runs_workspace_created on public.agent_runs(workspace_id, created_at desc);

create table public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id),
  agent text not null,
  position integer not null default 0,
  status text not null default 'pending',
  step text,
  events jsonb not null default '[]'::jsonb,
  summary text,
  started_at timestamptz,
  finished_at timestamptz,
  constraint agent_tasks_agent_check check (agent in ('lead','categorizer','recurring','anomaly','forecaster','budget','writer')),
  constraint agent_tasks_status_check check (status in ('pending','running','done','failed','skipped','canceled')),
  constraint agent_tasks_events_check check (jsonb_typeof(events)='array' and jsonb_array_length(events)<=60),
  constraint agent_tasks_run_agent_key unique (run_id, agent)
);

create table public.agent_proposals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id),
  agent text not null,
  kind text not null,
  conflict_key text not null,
  title text not null,
  detail text not null default '',
  evidence jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  confidence integer not null default 50,
  notes text[] not null default '{}'::text[],
  status text not null default 'proposed',
  result jsonb,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint agent_proposals_kind_check check (kind in ('categorize','recurring','budget','finding')),
  constraint agent_proposals_status_check check (status in ('proposed','applying','accepted','rejected','failed')),
  constraint agent_proposals_confidence_check check (confidence between 0 and 100),
  constraint agent_proposals_title_check check (char_length(title) between 1 and 200),
  constraint agent_proposals_run_conflict_key unique (run_id, conflict_key)
);
create index agent_proposals_workspace_status on public.agent_proposals(workspace_id, status);

alter table public.agent_runs enable row level security;
alter table public.agent_tasks enable row level security;
alter table public.agent_proposals enable row level security;
revoke all on public.agent_runs, public.agent_tasks, public.agent_proposals from anon, authenticated;
grant select on public.agent_runs, public.agent_tasks, public.agent_proposals to authenticated;
-- Owners decide proposals and request cancellation; agents write through the service role only.
grant update (status, result, decided_at) on public.agent_proposals to authenticated;
grant update (cancel_requested, updated_at) on public.agent_runs to authenticated;
grant select, insert, update, delete on public.agent_runs, public.agent_tasks, public.agent_proposals to service_role;

create policy own_agent_runs on public.agent_runs for select to authenticated using (public.owns_workspace(workspace_id));
create policy own_agent_runs_cancel on public.agent_runs for update to authenticated
  using (public.owns_workspace(workspace_id)) with check (public.owns_workspace(workspace_id) and cancel_requested);
create policy own_agent_tasks on public.agent_tasks for select to authenticated using (public.owns_workspace(workspace_id));
create policy own_agent_proposals on public.agent_proposals for select to authenticated using (public.owns_workspace(workspace_id));
create policy own_agent_proposals_decide on public.agent_proposals for update to authenticated
  using (public.owns_workspace(workspace_id)) with check (public.owns_workspace(workspace_id));

-- Parallel agents share one per-run model budget; this is the only way to spend it.
create function public.reserve_agent_model_call(p_run_id uuid, p_workspace_id uuid)
returns boolean language sql security definer set search_path='' as $$
  with reserved as (
    update public.agent_runs set model_calls=model_calls+1, updated_at=now()
    where id=p_run_id and workspace_id=p_workspace_id and status='running' and not cancel_requested and model_calls<model_budget
    returning 1)
  select exists(select 1 from reserved);
$$;
revoke all on function public.reserve_agent_model_call(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_agent_model_call(uuid, uuid) to service_role;
