-- The bank's full transaction beside the 8-column statement CSV (which must never change: its bytes are the dedupe hash).
-- One row per CSV row, keyed like source_transactions (import_id, row_number). The normalized columns are generic
-- (any bank on Enable Banking) context for the organizer; they never feed ledger amounts. Written by the bank sync
-- (service role); the owner can read it. Removed with its import on undo, and on reset.
create table public.bank_transaction_raw (
  import_id uuid not null references public.imports(id) on delete cascade,
  row_number integer not null check (row_number >= 2),
  workspace_id uuid not null references public.workspaces(id),
  bank_id text check (char_length(bank_id) <= 500),
  raw jsonb not null default '{}' check (jsonb_typeof(raw) = 'object' and octet_length(raw::text) <= 65536),
  payment_type text not null default 'unknown' check (payment_type in ('card','transfer','direct_debit','cash','fee_interest','top_up','exchange','unknown')),
  bank_code text check (char_length(bank_code) <= 200),
  bank_sub_code text check (char_length(bank_sub_code) <= 200),
  mcc text check (char_length(mcc) <= 10),
  counterparty_name text check (char_length(counterparty_name) <= 500),
  counterparty_iban text check (char_length(counterparty_iban) <= 34),
  counterparty_bic text check (char_length(counterparty_bic) <= 11),
  counterparty_ids jsonb not null default '[]' check (jsonb_typeof(counterparty_ids) = 'array' and octet_length(counterparty_ids::text) <= 8192),
  own_side_ids jsonb not null default '[]' check (jsonb_typeof(own_side_ids) = 'array' and octet_length(own_side_ids::text) <= 8192),
  creditor_id text check (char_length(creditor_id) <= 40),
  mandate_ref text check (char_length(mandate_ref) <= 40),
  -- Context only, as the bank states them: never used for ledger amounts.
  instructed_amount text check (char_length(instructed_amount) <= 40),
  instructed_currency text check (instructed_currency ~ '^[A-Z]{3}$'),
  exchange_rate text check (char_length(exchange_rate) <= 40),
  own_account boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (import_id, row_number)
);
create index bank_transaction_raw_workspace_idx on public.bank_transaction_raw(workspace_id);

alter table public.bank_transaction_raw enable row level security;
create policy bank_transaction_raw_owned on public.bank_transaction_raw for select using (public.owns_workspace(workspace_id));
revoke all on public.bank_transaction_raw from anon, authenticated;
grant select on public.bank_transaction_raw to authenticated;
grant all on public.bank_transaction_raw to service_role;

-- Undoing an import removes the rows it brought, and so the bank data kept for them. (The import row stays as history;
-- a later sync of the same window makes a new import and writes its own rows.)
create function public.remove_undone_bank_raw() returns trigger language plpgsql security definer set search_path='' as $$
begin
  delete from public.bank_transaction_raw where import_id = new.id;
  return new;
end;
$$;
revoke all on function public.remove_undone_bank_raw() from public, anon, authenticated;
create trigger imports_remove_bank_raw after update of status on public.imports
  for each row when (new.status = 'undone' and old.status is distinct from 'undone') execute function public.remove_undone_bank_raw();

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

  delete from public.bank_transaction_raw where workspace_id=ws;

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
