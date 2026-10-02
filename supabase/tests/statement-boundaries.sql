-- Exact source-row boundaries require matching account/currency/workspace evidence.
do $$
declare actor uuid:=gen_random_uuid(); foreign_actor uuid:=gen_random_uuid(); workspace uuid; foreign_workspace uuid;
  account uuid; foreign_account uuid; imported uuid; source uuid; transaction uuid;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(foreign_actor,'qa-'||foreign_actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  select id into strict foreign_workspace from public.workspaces where owner_id=foreign_actor;
  insert into public.accounts(workspace_id,name,currency_code) values(workspace,'Boundary','EUR') returning id into account;
  insert into public.accounts(workspace_id,name,currency_code) values(foreign_workspace,'Foreign boundary','EUR') returning id into foreign_account;
  insert into public.imports(workspace_id,filename,storage_path,file_hash) values(workspace,'boundary.csv','synthetic',actor::text) returning id into imported;
  insert into public.source_transactions(workspace_id,import_id,row_number,original_row,fee_evidence)
    values(workspace,imported,2,'{"timestamp":"2026-10-01T14:30:00+02:00"}','{"treatment":"included"}') returning id into source;
  insert into public.transactions(workspace_id,account_id,posted_on,posted_at,description,amount_minor,currency_code)
    values(workspace,account,'2026-10-01','2026-10-01T12:30:00Z','Boundary transaction',-100,'EUR') returning id into transaction;
  insert into public.transaction_sources(transaction_id,source_transaction_id) values(transaction,source);
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind,source_transaction_id)
    values(workspace,account,1000,'EUR','2026-10-01T12:30:00Z','synthetic','after_transaction',source);
  if not exists(select 1 from public.transactions where id=transaction and posted_at='2026-10-01T14:30:00+02:00'::timestamptz) then
    raise exception 'Offset timestamp did not preserve exact instant';
  end if;
  begin
    insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind,source_transaction_id)
      values(workspace,foreign_account,1000,'EUR',now(),'synthetic','after_transaction',source);
    raise exception 'Foreign account boundary accepted' using errcode='ZX001';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind,source_transaction_id)
      values(workspace,account,1000,'USD',now(),'synthetic','after_transaction',source);
    raise exception 'Mismatched currency boundary accepted' using errcode='ZX001';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind)
      values(workspace,account,1000,'EUR',now(),'synthetic','after_transaction');
    raise exception 'After-row boundary without source accepted' using errcode='ZX001';
  exception when check_violation then null; end;
  execute 'reset role';
  begin
    update public.source_transactions set fee_evidence='{"treatment":null}' where id=source;
    raise exception 'Null fee treatment accepted' using errcode='ZX001';
  exception when check_violation then null; end;
end;
$$;
