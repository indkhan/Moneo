-- RLS policies also need SQL privileges. Supabase projects usually provide
-- default grants; make this app's required access explicit and portable.
-- Covers direct authenticated CRUD only (workflows use service_role, guarded
-- writes use SECURITY DEFINER RPCs). data_sources has SELECT only for the
-- imports WITH CHECK; merchants/forecast_runs have no authenticated use.
-- background_jobs/saved_analyses/recurring_* already have SELECT in 005/008;
-- spending_plans is granted in 014 (created after this file).
grant usage on schema public to authenticated;

grant select on public.workspaces, public.accounts, public.balance_snapshots,
  public.data_sources, public.imports, public.source_transactions,
  public.categories, public.transactions,
  public.transaction_sources, public.correction_events,
  public.goals, public.goal_allocations, public.financial_assumptions,
  public.scenarios, public.scenario_overrides,
  public.artifacts, public.artifact_versions, public.artifact_state,
  public.dashboard_items, public.conversations, public.messages,
  public.fx_rates to authenticated;

grant insert on public.accounts, public.balance_snapshots,
  public.imports, public.goals, public.financial_assumptions,
  public.scenarios, public.scenario_overrides,
  public.dashboard_items, public.conversations, public.messages,
  public.fx_rates to authenticated;

grant update (display_currency) on public.workspaces to authenticated;
grant update (status, error) on public.imports to authenticated;
grant update (state, version, updated_at) on public.artifact_state to authenticated;
grant update on public.dashboard_items to authenticated;
grant delete on public.dashboard_items to authenticated;
