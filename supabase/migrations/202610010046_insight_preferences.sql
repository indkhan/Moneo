create table public.insight_preferences (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  important_only boolean not null default true,
  minimum_change_minor bigint not null default 2000 check(minimum_change_minor>=0),
  currency_code text not null default 'EUR' check(currency_code ~ '^[A-Z]{3}$'),
  upcoming_days integer not null default 7 check(upcoming_days between 1 and 30),
  max_items integer not null default 8 check(max_items between 1 and 20), updated_at timestamptz not null default now()
);
create table public.insight_dismissals (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  evidence_key text not null check(evidence_key ~ '^[0-9a-f]{64}$'),
  insight_type text not null check(insight_type in ('spending_changes','budget_pressure','unusual_activity','recurring_changes','upcoming_obligations','cash_shortfall','goal_progress','asset_debt','data_quality')),
  created_at timestamptz not null default now(), primary key(workspace_id,evidence_key)
);
alter table public.insight_preferences enable row level security;
alter table public.insight_dismissals enable row level security;
create policy own_insight_preferences on public.insight_preferences for all to authenticated using(public.owns_workspace(workspace_id)) with check(public.owns_workspace(workspace_id));
create policy own_insight_dismissals on public.insight_dismissals for all to authenticated using(public.owns_workspace(workspace_id)) with check(public.owns_workspace(workspace_id));
grant select,insert,update,delete on public.insight_preferences,public.insight_dismissals to authenticated;
grant all on public.insight_preferences,public.insight_dismissals to service_role;
