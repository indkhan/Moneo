create table public.background_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  kind text not null check (kind = 'financial_review'),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'canceled')),
  stage text not null default 'queued',
  error text,
  cancel_requested boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.saved_analyses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  job_id uuid not null unique references public.background_jobs(id),
  title text not null,
  body text not null,
  evidence jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.background_jobs enable row level security;
alter table public.saved_analyses enable row level security;

revoke all on public.background_jobs, public.saved_analyses from anon, authenticated;
grant select on public.background_jobs, public.saved_analyses to authenticated;

create policy own_background_jobs on public.background_jobs for select to authenticated
using (public.owns_workspace(workspace_id));

create policy own_saved_analyses on public.saved_analyses for select to authenticated
using (public.owns_workspace(workspace_id));
