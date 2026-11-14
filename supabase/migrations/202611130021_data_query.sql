-- Read-only SQL for chat (data_query). The model writes one SELECT over the owner's finance records.
-- It runs as moneo_reader, a role that can only read the views in moneo_query: an allowlist of finance
-- tables and columns. Bank and Scalable tokens, service keys, settings, chats, auth and storage have no
-- view, so they can't be named. Each view keeps to the caller's workspace and the AI data scopes from
-- Settings through pg_temp.moneo_query_scope, which data_query fills before the query runs and the query
-- can't change. lib/ai/data-query.ts describes these views to the model; keep the two in step.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'moneo_reader') then
    create role moneo_reader nologin noinherit;
  end if;
end $$;
-- The migration role owns moneo_query.run below, so it needs to be able to hand ownership over.
grant moneo_reader to postgres;

create schema if not exists moneo_query;
revoke all on schema moneo_query from public;
grant usage on schema moneo_query to authenticated, moneo_reader;

-- The workspace a query may read, when the view's scope is allowed. Runs as the reader.
create or replace function moneo_query.workspace_for(p_scope text) returns uuid
language plpgsql stable security invoker set search_path = '' as $$
declare v_workspace uuid; v_scopes text[];
begin
  select s.workspace_id, s.scopes into v_workspace, v_scopes from pg_temp.moneo_query_scope s;
  if v_workspace is null then raise exception 'moneo_query views are only readable through data_query' using errcode = '42501'; end if;
  if not p_scope = any(v_scopes) then
    raise exception '% data is turned off for the AI in Settings', p_scope using errcode = '42501';
  end if;
  return v_workspace;
end $$;
revoke all on function moneo_query.workspace_for(text) from public;
grant execute on function moneo_query.workspace_for(text) to moneo_reader;

create or replace view moneo_query.accounts as
  select a.id, a.name, a.type, a.currency_code, a.archived_at, a.created_at
  from public.accounts a where a.workspace_id = moneo_query.workspace_for('accounts');

create or replace view moneo_query.balance_snapshots as
  select b.id, b.account_id, b.amount_minor, b.currency_code, b.as_of, b.provenance, b.balance_type, b.created_at
  from public.balance_snapshots b where b.workspace_id = moneo_query.workspace_for('accounts') and b.undone_at is null;

create or replace view moneo_query.categories as
  select c.id, c.name from public.categories c where c.workspace_id = moneo_query.workspace_for('transactions');

create or replace view moneo_query.merchants as
  select m.id, m.name from public.merchants m where m.workspace_id = moneo_query.workspace_for('transactions');

create or replace view moneo_query.transactions as
  select t.id, t.account_id, t.posted_on, t.posted_at, t.description, t.amount_minor, t.currency_code, t.status, t.kind,
    t.category_id, t.merchant_id, t.tags, t.event_name, t.note, t.transfer_id, t.refund_of_id, t.created_at
  from public.transactions t where t.workspace_id = moneo_query.workspace_for('transactions');

-- Rows for category totals: a split transaction's parts instead of the whole, plus fees of linked transfers.
create or replace view moneo_query.effective_transactions as
  select e.id, e.parent_transaction_id, e.account_id, e.posted_on, e.description, e.amount_minor, e.currency_code, e.status, e.kind,
    e.category_id, e.merchant_id, e.note, e.transfer_id, e.refund_of_id, e.tags, e.event_name
  from public.effective_transactions e where e.workspace_id = moneo_query.workspace_for('transactions');

create or replace view moneo_query.fx_rates as
  select r.from_currency, r.to_currency, r.rate_text, r.rate_date, r.source
  from public.fx_rates r where r.workspace_id = moneo_query.workspace_for('transactions');

create or replace view moneo_query.recurring_series as
  select r.id, r.account_id, r.label, r.cadence, r.currency_code, r.amount_min_minor, r.amount_max_minor, r.occurrences, r.confidence, r.status, r.created_at
  from public.recurring_series r where r.workspace_id = moneo_query.workspace_for('planning');

create or replace view moneo_query.recurring_series_transactions as
  select r.series_id, r.transaction_id
  from public.recurring_series_transactions r where r.workspace_id = moneo_query.workspace_for('planning');

create or replace view moneo_query.goals as
  select g.id, g.name, g.target_minor, g.planned_monthly_minor, g.recorded_saved_minor, g.saved_as_of, g.currency_code, g.target_date,
    g.priority, g.status, g.notes, g.created_at
  from public.goals g where g.workspace_id = moneo_query.workspace_for('planning');

create or replace view moneo_query.wealth_items as
  select w.id, w.kind, w.name, w.currency_code, w.amount_minor, w.quantity_text, w.unit_price_text, w.cost_basis_minor, w.as_of,
    w.linked_account_id, w.annual_rate_text, w.monthly_payment_minor, w.next_payment_on, w.created_at, w.updated_at
  from public.wealth_items w where w.workspace_id = moneo_query.workspace_for('planning') and w.removed_at is null;

create or replace view moneo_query.iou_repayments as
  select r.id, r.item_id, r.transaction_id, r.applied_minor, r.currency_code, r.transaction_posted_on, r.created_at
  from public.iou_repayments r where r.workspace_id = moneo_query.workspace_for('planning') and r.undone_at is null;

create or replace view moneo_query.spending_plans as
  select p.id, p.category_id, p.currency_code, p.limit_minor, p.enabled, p.rollover
  from public.spending_plans p where p.workspace_id = moneo_query.workspace_for('planning');

create or replace view moneo_query.scalable_transfers as
  select s.provider_id, s.type, s.amount_minor, s.currency_code, s.occurred_at, s.on_date, s.status, s.is_cancellation, s.description
  from public.scalable_transfers s where s.workspace_id = moneo_query.workspace_for('accounts');

create or replace view moneo_query.scalable_value_history as
  select s.on_date, s.currency_code, s.securities_minor, s.crypto_minor, s.cash_minor, s.total_minor
  from public.scalable_value_history s where s.workspace_id = moneo_query.workspace_for('accounts');

create or replace view moneo_query.imports as
  select i.id, i.filename, i.status, i.total_rows, i.new_rows, i.matched_rows, i.review_rows, i.rejected_rows, i.error, i.created_at
  from public.imports i where i.workspace_id = moneo_query.workspace_for('imports') and i.undone_at is null;

revoke all on all tables in schema moneo_query from public, anon, authenticated, service_role;
grant select on all tables in schema moneo_query to moneo_reader;

-- Runs the query as moneo_reader. A security-definer function can't change role, so set_config('role', …)
-- inside the query fails instead of switching to a role the connection may use.
create or replace function moneo_query.run(p_sql text, p_max_rows integer, p_max_bytes integer) returns jsonb
language plpgsql volatile security definer set search_path = moneo_query as $$
declare
  v_row json; v_columns jsonb; v_cells jsonb; v_rows jsonb := '[]'::jsonb; v_count integer := 0; v_bytes integer := 0; v_cut text;
begin
  for v_row in execute 'select pg_catalog.row_to_json(q) from (' || p_sql || E'\n) q limit ' || (p_max_rows + 1) loop
    if v_count >= p_max_rows then v_cut := 'rows'; exit; end if;
    -- Every number comes back as its exact text, so bigint minor units never lose precision in JSON.
    select pg_catalog.jsonb_agg(case pg_catalog.json_typeof(e.value) when 'number' then pg_catalog.to_jsonb(e.value #>> '{}') else e.value::jsonb end order by e.n),
      pg_catalog.jsonb_agg(e.key order by e.n)
      into v_cells, v_columns from pg_catalog.json_each(v_row) with ordinality e(key, value, n);
    v_bytes := v_bytes + pg_catalog.octet_length(v_cells::text);
    if v_bytes > p_max_bytes then v_cut := 'size'; exit; end if;
    v_rows := v_rows || pg_catalog.jsonb_build_array(v_cells);
    v_count := v_count + 1;
  end loop;
  return pg_catalog.jsonb_build_object('columns', coalesce(v_columns, '[]'::jsonb), 'rows', v_rows, 'truncated', v_cut);
end $$;
-- A new owner needs CREATE on the schema at the moment it takes over; the reader keeps no such right.
grant create on schema moneo_query to moneo_reader;
alter function moneo_query.run(text, integer, integer) owner to moneo_reader;
revoke create on schema moneo_query from moneo_reader;
revoke all on function moneo_query.run(text, integer, integer) from public;
grant execute on function moneo_query.run(text, integer, integer) to authenticated;

-- Chat's entry point, called as the signed-in owner. Query mistakes come back as { error } for the model
-- to fix; the query's own effects (settings it set, the scope table) are rolled back either way.
-- PostgREST applies the function's statement_timeout before the call starts, so a slow query is canceled.
create or replace function public.data_query(p_sql text, p_scopes text[], p_max_rows integer default 500) returns jsonb
language plpgsql volatile security invoker set search_path = '' set statement_timeout = '5s' as $$
declare
  v_workspace uuid; v_sql text := pg_catalog.btrim(coalesce(p_sql, '')); v_result jsonb; v_error text;
begin
  select w.id into v_workspace from public.workspaces w where w.owner_id = auth.uid();
  if v_workspace is null then raise exception 'No workspace for this user' using errcode = '42501'; end if;
  if p_scopes is null or not p_scopes <@ array['accounts','transactions','planning','imports'] then
    raise exception 'Unknown AI data scope' using errcode = '22023';
  end if;
  v_sql := pg_catalog.regexp_replace(v_sql, ';\s*$', '');
  if v_sql = '' or pg_catalog.length(v_sql) > 8000 then return pg_catalog.jsonb_build_object('error', 'The query must be 1 to 8000 characters.'); end if;
  if pg_catalog.strpos(v_sql, ';') > 0 then return pg_catalog.jsonb_build_object('error', 'Send exactly one SELECT statement, without semicolons.'); end if;
  begin
    create temp table moneo_query_scope (workspace_id uuid not null, scopes text[] not null) on commit drop;
    insert into pg_temp.moneo_query_scope values (v_workspace, p_scopes);
    grant select on pg_temp.moneo_query_scope to moneo_reader;
    perform pg_catalog.set_config('transaction_read_only', 'on', true);
    v_result := moneo_query.run(v_sql, least(greatest(coalesce(p_max_rows, 500), 1), 500), 200000);
    raise exception using errcode = 'MQ000';
  exception
    when sqlstate 'MQ000' then null;
    when query_canceled then v_error := 'The query took longer than 5 seconds. Narrow it with filters or aggregate.';
    when others then v_error := sqlerrm;
  end;
  if v_error is not null then return pg_catalog.jsonb_build_object('error', v_error); end if;
  return v_result;
end $$;
revoke all on function public.data_query(text, text[], integer) from public, anon;
grant execute on function public.data_query(text, text[], integer) to authenticated;
