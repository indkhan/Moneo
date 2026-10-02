create table public.dashboard_layouts (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  items text[] not null check(cardinality(items)<=50),
  version integer not null default 1 check(version>0),
  updated_at timestamptz not null default now()
);
alter table public.dashboard_layouts enable row level security;
create policy own_dashboard_layouts on public.dashboard_layouts for all to authenticated
  using(public.owns_workspace(workspace_id)) with check(public.owns_workspace(workspace_id));
revoke all on public.dashboard_layouts from public,anon;
grant select,insert,update on public.dashboard_layouts to authenticated;
