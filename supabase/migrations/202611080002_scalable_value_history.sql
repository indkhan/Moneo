-- Past Scalable values worked out from Scalable's own transactions and price charts. They are a calculation,
-- not a record, so they live apart from wealth_items and wealth_events: the event list stays the owner's real
-- history. Rows only exist for days before the first real synced value, and a run replaces all of them at once.
-- A disconnect keeps them, as it keeps synced wealth items; reset all data clears them.
create table public.scalable_value_history (
  workspace_id uuid not null references public.workspaces(id),
  on_date date not null,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  securities_minor bigint not null,
  crypto_minor bigint not null,
  cash_minor bigint not null,
  total_minor bigint not null,
  primary key (workspace_id, on_date),
  check (total_minor = securities_minor + crypto_minor + cash_minor)
);
alter table public.scalable_value_history enable row level security;
create policy scalable_value_history_owner_select on public.scalable_value_history for select to authenticated using (public.owns_workspace(workspace_id));
revoke all on public.scalable_value_history from public, anon, authenticated;
grant select on public.scalable_value_history to authenticated;
grant all on public.scalable_value_history to service_role;

-- The outcome of the last calculation. Kept apart from last_error, which tells the owner a sync needs attention.
alter table public.scalable_connections add column history_status text check (history_status in ('ok','failed')),
  add column history_checked_on date,
  add column history_error text check (char_length(history_error) <= 1000);
grant select (history_status, history_checked_on) on public.scalable_connections to authenticated;

create function public.replace_scalable_value_history(p_connection_id uuid, p_rows jsonb, p_checked_on date) returns integer
language plpgsql security definer set search_path='' as $$
declare connection public.scalable_connections%rowtype; saved integer;
begin
  if p_connection_id is null or p_checked_on is null or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Invalid Scalable value history' using errcode = '22023'; end if;
  select * into connection from public.scalable_connections where id = p_connection_id and status = 'active' for update;
  if not found then raise exception 'Scalable connection is not active' using errcode = 'P0002'; end if;
  delete from public.scalable_value_history where workspace_id = connection.workspace_id;
  insert into public.scalable_value_history(workspace_id, on_date, currency_code, securities_minor, crypto_minor, cash_minor, total_minor)
    select connection.workspace_id, row.on_date, row.currency_code, row.securities_minor, row.crypto_minor, row.cash_minor, row.total_minor
    from jsonb_to_recordset(p_rows) as row(on_date date, currency_code text, securities_minor bigint, crypto_minor bigint, cash_minor bigint, total_minor bigint);
  get diagnostics saved = row_count;
  update public.scalable_connections set history_status = 'ok', history_checked_on = p_checked_on, history_error = null where id = p_connection_id;
  return saved;
end;
$$;
revoke all on function public.replace_scalable_value_history(uuid, jsonb, date) from public, anon, authenticated;
grant execute on function public.replace_scalable_value_history(uuid, jsonb, date) to service_role;

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

  -- AI conversations and reviews.
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
  delete from public.scalable_value_history where workspace_id=ws;
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
