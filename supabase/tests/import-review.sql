-- Synthetic fixtures only. Run through run-sql.mjs, which always rolls back.
do $$
declare
  v_user uuid := gen_random_uuid();
  v_workspace uuid;
  v_current uuid := gen_random_uuid();
  v_savings uuid := gen_random_uuid();
  v_source uuid := gen_random_uuid();
  v_import uuid := gen_random_uuid();
  v_row uuid := gen_random_uuid();
  v_bad_row uuid := gen_random_uuid();
  v_transaction public.transactions%rowtype;
begin
  insert into auth.users (id, email) values (v_user, 'qa-' || v_user || '@example.invalid');
  select id into strict v_workspace from public.workspaces where owner_id = v_user;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  insert into public.accounts(id, workspace_id, name, currency_code) values
    (v_current, v_workspace, 'Synthetic Current', 'EUR'),
    (v_savings, v_workspace, 'Synthetic Savings', 'EUR');
  insert into public.data_sources(id, workspace_id, account_id, kind, name)
    values(v_source, v_workspace, v_current, 'file', 'Synthetic');
  insert into public.imports(id, workspace_id, source_id, filename, storage_path, file_hash, status, mapping, review_rows)
    values(v_import, v_workspace, v_source, 'synthetic.csv', 'synthetic', v_import::text, 'completed',
      '{"accountName":"Synthetic Current","currencyCode":"EUR","productColumn":"Product","statusColumn":"State","accountRoutes":[{"productValue":"Current","currencyCode":"EUR","accountName":"Synthetic Current"},{"productValue":"Savings","currencyCode":"EUR","accountName":"Synthetic Savings"}]}'::jsonb, 2);
  insert into public.source_transactions(id, workspace_id, import_id, row_number, original_row, status) values
    (v_row, v_workspace, v_import, 2, '{"Product":"Savings","State":"PENDING"}', 'review'),
    (v_bad_row, v_workspace, v_import, 3, '{"Product":"Savings","State":"REVERTED"}', 'review');
  perform public.resolve_import_review(v_row, 'accept', '2026-09-01', 'Synthetic overlap', 100, 'EUR');
  select t.* into strict v_transaction from public.transactions t join public.transaction_sources ts on ts.transaction_id=t.id where ts.source_transaction_id=v_row;
  if v_transaction.account_id <> v_savings or v_transaction.status <> 'pending' then
    raise exception 'Overlap acceptance must preserve reviewed product routing and pending status';
  end if;
  perform public.resolve_import_review(v_row, 'accept', '2026-09-01', 'Synthetic overlap', 100, 'EUR');
  if (select count(*) from public.transaction_sources where source_transaction_id=v_row) <> 1 then
    raise exception 'Repeat acceptance must be idempotent';
  end if;
  begin
    perform public.resolve_import_review(v_bad_row, 'accept', '2026-09-01', 'Unsupported state', 100, 'EUR');
    raise exception 'Unsupported source state must not be accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.resolve_import_review(v_bad_row, null);
    raise exception 'Null action must not reject evidence';
  exception when sqlstate '22023' then null;
  end;
  if (select status from public.source_transactions where id=v_bad_row) <> 'review' then
    raise exception 'Invalid actions must leave evidence unresolved';
  end if;
  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  begin
    perform public.resolve_import_review(v_bad_row, 'reject');
    raise exception 'Foreign workspace review must not be allowed';
  exception when sqlstate 'P0002' then null;
  end;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  update public.imports set mapping = mapping || '{"currencyColumn":"Currency"}'::jsonb where id=v_import;
  update public.source_transactions set original_row = '{"Product":"Savings","State":"COMPLETED","Currency":"USD"}'::jsonb where id=v_bad_row;
  begin
    perform public.resolve_import_review(v_bad_row, 'accept', '2026-09-01', 'Adversarial currency', 100, 'EUR');
    raise exception 'Caller currency must match source evidence';
  exception when sqlstate '22023' then null;
  end;
end;
$$;
