-- Chat's read-only SQL (data_query). Synthetic users only; the migration runner executes this inside a rollback.
do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  workspace_a uuid;
  workspace_b uuid;
  account_a uuid := gen_random_uuid();
  account_b uuid := gen_random_uuid();
  everything text[] := array['accounts','transactions','planning','imports'];
  result jsonb;
  probe text;
begin
  insert into auth.users(id,email) values(user_a,'qa-'||user_a||'@example.invalid'),(user_b,'qa-'||user_b||'@example.invalid');
  select id into strict workspace_a from public.workspaces where owner_id=user_a;
  select id into strict workspace_b from public.workspaces where owner_id=user_b;
  insert into public.accounts(id,workspace_id,name,currency_code) values(account_a,workspace_a,'Synthetic mine','EUR'),(account_b,workspace_b,'Synthetic foreign','EUR');
  insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code)
    values(workspace_a,account_a,'2026-10-01','Synthetic exact',9007199254740993,'EUR'),(workspace_b,account_b,'2026-10-01','Synthetic foreign',-100,'EUR');

  perform set_config('request.jwt.claim.sub', user_a::text, true);
  execute 'set local role authenticated';

  -- Only the caller's workspace, with exact money as text.
  result := public.data_query('select a.name, t.amount_minor, t.currency_code from accounts a join transactions t on t.account_id = a.id', everything);
  if result->'rows' <> '[["Synthetic mine","9007199254740993","EUR"]]'::jsonb then raise exception 'Expected only the own row with exact text money, got %', result; end if;

  -- Claims changed inside the query don't reach another workspace.
  result := public.data_query(format('select set_config(%L, %L, true) s, (select count(*) from accounts where name = %L) n', 'request.jwt.claim.sub', user_b, 'Synthetic foreign'), everything);
  if result->'rows'->0->>1 <> '0' then raise exception 'Changed claims must not reveal another workspace: %', result; end if;

  -- Writes, other tables, other schemas, role changes and dynamic SQL are refused.
  foreach probe in array array[
    'with d as (delete from transactions returning 1) select * from d',
    'select * from public.accounts',
    'select * from public.service_keys',
    'select * from public.bank_connections',
    'select * from public.scalable_connections',
    'select * from public.workspace_settings',
    'select * from auth.users',
    'select * from storage.objects',
    'select * from vault.secrets',
    'select set_config(''role'', ''service_role'', true)',
    'select query_to_xml(''select * from public.service_keys'', true, false, '''')',
    'select 1; delete from accounts',
    'select * from wealth_items'
  ] loop
    result := public.data_query(probe, case when probe like '%wealth_items%' then array['accounts','transactions'] else everything end);
    if result->>'error' is null then raise exception 'Query must be refused: % returned %', probe, result; end if;
  end loop;

  -- The query ran read-only and left nothing behind: no scope table, no changed role.
  if to_regclass('pg_temp.moneo_query_scope') is not null then raise exception 'Scope table must not outlive the query'; end if;
  if current_user <> 'authenticated' then raise exception 'Role must be restored, got %', current_user; end if;
  if (select count(*) from public.transactions) <> 1 then raise exception 'Writes must not happen'; end if;

  -- At most 500 rows, and the cut is reported.
  result := public.data_query('select g from generate_series(1, 600) g', everything);
  if jsonb_array_length(result->'rows') <> 500 or result->>'truncated' <> 'rows' then raise exception 'Expected 500 rows and a row cut, got % rows', jsonb_array_length(result->'rows'); end if;

  -- The views can't be read except through data_query.
  begin
    perform moneo_query.run('select * from accounts', 1, 1000);
    raise exception 'Calling run without a scope must fail';
  exception when others then
    if sqlerrm = 'Calling run without a scope must fail' then raise; end if;
  end;

  execute 'reset role';
end $$;
