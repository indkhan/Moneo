-- Reset removes both agent runs (202610160011) and bank connections (202610160102); whichever of those
-- applied last dropped the other's tables from the function. Same body as 202610160102 plus the agent tables.
create or replace function public.reset_workspace() returns void language plpgsql security definer set search_path='' as $$
declare ws uuid; owner uuid := auth.uid();
begin
  if owner is null then raise exception 'Unauthorized' using errcode='42501'; end if;
  select id into ws from public.workspaces where owner_id=owner for update;
  if not found then raise exception 'Workspace unavailable' using errcode='P0002'; end if;
  -- Deleted history is not undoable, so skip planning audit rows and link-edit guards.
  perform set_config('moneo.planning_undo','true',true);
  perform set_config('moneo.link_edit','on',true);

  -- Agent team runs, tasks and proposals.
  delete from public.agent_proposals where workspace_id=ws;
  delete from public.agent_tasks where workspace_id=ws;
  delete from public.agent_runs where workspace_id=ws;

  -- AI conversations, reviews.
  delete from public.saved_analyses where workspace_id=ws;
  delete from public.summary_runs where workspace_id=ws;
  delete from public.background_jobs where workspace_id=ws;
  delete from public.chat_requests where workspace_id=ws;
  delete from public.messages where workspace_id=ws;
  delete from public.conversations where workspace_id=ws;
  delete from public.dashboard_layouts where workspace_id=ws;

  -- Preferences, views and settings.
  delete from public.insight_dismissals where workspace_id=ws;
  delete from public.insight_preferences where workspace_id=ws;
  delete from public.financial_evidence_receipts where workspace_id=ws;
  delete from public.transaction_views where workspace_id=ws;
  delete from public.fx_rates where workspace_id=ws;
  delete from public.workspace_settings where workspace_id=ws;

  -- Everything that points at transactions.
  delete from public.transaction_link_fees where workspace_id=ws;
  delete from public.transaction_links where workspace_id=ws;
  delete from public.transaction_splits where workspace_id=ws;
  delete from public.transaction_split_sets where workspace_id=ws;
  delete from public.pending_hold_resolutions where workspace_id=ws;
  delete from public.correction_events where workspace_id=ws;
  delete from public.recurring_occurrence_settlements where workspace_id=ws;
  delete from public.recurring_series_transactions where workspace_id=ws;
  delete from public.recurring_series where workspace_id=ws;
  delete from public.manual_transaction_entries where workspace_id=ws;
  delete from public.money_metadata_events where workspace_id=ws;
  delete from public.organization_reviews where workspace_id=ws;
  delete from public.organization_rules where workspace_id=ws;
  delete from public.transaction_batches where workspace_id=ws;
  delete from public.wealth_events where workspace_id=ws;
  delete from public.wealth_items where workspace_id=ws;
  delete from public.transaction_sources where transaction_id in (select id from public.transactions where workspace_id=ws)
    or source_transaction_id in (select id from public.source_transactions where workspace_id=ws);
  delete from public.balance_snapshots where workspace_id=ws;
  update public.transactions set transfer_id=null, refund_of_id=null
    where workspace_id=ws and (transfer_id is not null or refund_of_id is not null);
  delete from public.transactions where workspace_id=ws;

  -- Bank connections, then imports.
  delete from public.bank_connection_accounts where workspace_id=ws;
  delete from public.bank_connections where workspace_id=ws;

  -- Imports.
  delete from public.source_transactions where workspace_id=ws;
  delete from public.import_control_events where workspace_id=ws;
  delete from public.import_staging where workspace_id=ws;
  delete from public.imports where workspace_id=ws;
  delete from public.data_sources where workspace_id=ws;

  -- Goals, plans, scenarios and budgets.
  delete from public.goal_reservation_events where workspace_id=ws;
  delete from public.goal_allocations where workspace_id=ws;
  delete from public.goal_events where workspace_id=ws;
  delete from public.goals where workspace_id=ws;
  delete from public.forecast_runs where workspace_id=ws;
  delete from public.scenario_overrides where workspace_id=ws;
  delete from public.scenario_events where workspace_id=ws;
  delete from public.scenarios where workspace_id=ws;
  delete from public.spending_plan_limits where workspace_id=ws;
  delete from public.spending_plans where workspace_id=ws;
  delete from public.financial_assumptions where workspace_id=ws;
  delete from public.planning_events where workspace_id=ws;
  delete from public.forecast_preference_events where workspace_id=ws;
  delete from public.forecast_preferences where workspace_id=ws;

  -- Remaining parents, then a fresh workspace exactly like create_private_workspace().
  delete from public.merchants where workspace_id=ws;
  delete from public.categories where workspace_id=ws;
  delete from public.accounts where workspace_id=ws;
  delete from public.workspaces where id=ws;
  insert into public.workspaces(owner_id) values(owner);
end;
$$;
revoke all on function public.reset_workspace() from public,anon;
grant execute on function public.reset_workspace() to authenticated;
