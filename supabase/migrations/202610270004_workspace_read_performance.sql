-- Faster owned reads without changing who can see what.
--
-- Policies called owns_workspace(workspace_id) once per row (a security definer
-- function cannot be inlined), so a count over 20k owned transactions spent ~300 ms
-- in RLS alone. The same rule as an uncorrelated subquery is evaluated once per query.
-- owns_workspace stays for the RPCs that call it.
create function public.owned_workspace_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select id from public.workspaces where owner_id = (select auth.uid());
$$;
revoke all on function public.owned_workspace_ids() from public;
grant execute on function public.owned_workspace_ids() to authenticated;

do $$
declare
  policy record;
  -- The application schema, taken from the function above so isolated replays work too.
  app_schema constant oid := (select pronamespace from pg_proc where oid = 'public.owned_workspace_ids'::regproc);
  pattern constant text := '(\w+\.)?owns_workspace\(((\w+\.)?workspace_id)\)';
  replacement constant text := '(\2 IN (SELECT public.owned_workspace_ids()))';
begin
  for policy in
    select p.polname, c.relname, pg_get_expr(p.polqual, p.polrelid) as qual, pg_get_expr(p.polwithcheck, p.polrelid) as with_check
    from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relnamespace = app_schema
      and (pg_get_expr(p.polqual, p.polrelid) ~ pattern or pg_get_expr(p.polwithcheck, p.polrelid) ~ pattern)
  loop
    if policy.qual is not null then
      execute format('alter policy %I on %s.%I using (%s)', policy.polname, app_schema::regnamespace, policy.relname, regexp_replace(policy.qual, pattern, replacement, 'g'));
    end if;
    if policy.with_check is not null then
      execute format('alter policy %I on %s.%I with check (%s)', policy.polname, app_schema::regnamespace, policy.relname, regexp_replace(policy.with_check, pattern, replacement, 'g'));
    end if;
  end loop;
  if exists (select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relnamespace = app_schema and (pg_get_expr(p.polqual, p.polrelid) ~ pattern or pg_get_expr(p.polwithcheck, p.polrelid) ~ pattern)) then
    raise exception 'A policy still calls owns_workspace per row';
  end if;
end $$;

-- Every owned read filters by workspace_id; without a leading index each one scanned
-- all workspaces' rows. (workspace_id, id) also serves the id-ordered paging reads.
create index transactions_workspace_id on public.transactions(workspace_id, id);
create index transactions_workspace_posted on public.transactions(workspace_id, posted_on desc, id desc);
create index messages_workspace on public.messages(workspace_id);
create index source_transactions_workspace_id on public.source_transactions(workspace_id, id);
create index correction_events_workspace on public.correction_events(workspace_id);
create index agent_tasks_workspace on public.agent_tasks(workspace_id);
create index accounts_workspace on public.accounts(workspace_id, id);
create index balance_snapshots_workspace_id on public.balance_snapshots(workspace_id, id);
create index data_sources_workspace on public.data_sources(workspace_id);
create index import_staging_workspace on public.import_staging(workspace_id);
create index wealth_items_workspace on public.wealth_items(workspace_id);
create index recurring_series_transactions_workspace on public.recurring_series_transactions(workspace_id);
create index financial_assumptions_workspace on public.financial_assumptions(workspace_id);
create index scenario_overrides_workspace on public.scenario_overrides(workspace_id);
create index artifact_versions_workspace on public.artifact_versions(workspace_id);
create index transaction_splits_workspace on public.transaction_splits(workspace_id);
create index bank_connection_accounts_workspace on public.bank_connection_accounts(workspace_id);
create index scenarios_workspace on public.scenarios(workspace_id);
create index transaction_link_fees_workspace on public.transaction_link_fees(workspace_id);
create index chat_steers_workspace on public.chat_steers(workspace_id);
create index saved_analyses_workspace on public.saved_analyses(workspace_id);
create index goal_allocations_workspace on public.goal_allocations(workspace_id);
create index forecast_runs_workspace on public.forecast_runs(workspace_id);
