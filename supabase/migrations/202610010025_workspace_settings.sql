create table public.workspace_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  timezone text not null default 'Europe/Berlin' check(length(timezone) between 1 and 100),
  locale text not null default 'en-GB' check(length(locale) between 1 and 50),
  theme text not null default 'system' check(theme in ('system','light','dark')),
  openrouter_model text check(length(openrouter_model) between 1 and 200),
  ai_data_scopes text[] not null default array['accounts','transactions','planning','imports']::text[]
    check(ai_data_scopes <@ array['accounts','transactions','planning','imports']::text[]),
  muted_insight_types text[] not null default '{}'::text[] check(muted_insight_types <@
    array['spending_changes','budget_pressure','unusual_activity','recurring_changes','upcoming_obligations','cash_shortfall','goal_progress','asset_debt','data_quality']::text[]),
  summary_cadence text not null default 'none' check(summary_cadence in ('none','weekly','monthly')),
  summary_time text not null default '09:00' check(summary_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  updated_at timestamptz not null default now()
);
alter table public.workspace_settings enable row level security;
create policy own_workspace_settings on public.workspace_settings for all to authenticated
  using(public.owns_workspace(workspace_id)) with check(public.owns_workspace(workspace_id));
revoke all on public.workspace_settings from public,anon;
grant select,insert,update on public.workspace_settings to authenticated;
