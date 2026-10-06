-- Synthetic normalized ingestion/review parity. The runner rolls back the entire schema.
do $$
declare
  actor uuid:=gen_random_uuid(); foreign_actor uuid:=gen_random_uuid(); workspace uuid; foreign_workspace uuid;
  account uuid:=gen_random_uuid(); ordinary_account uuid:=gen_random_uuid(); replacement uuid:=gen_random_uuid(); foreign_account uuid:=gen_random_uuid();
  imported uuid:=gen_random_uuid(); ordinary_import uuid:=gen_random_uuid(); route_source uuid:=gen_random_uuid(); ordinary_route_source uuid:=gen_random_uuid();
  source uuid:=gen_random_uuid(); archived_source uuid:=gen_random_uuid(); missing_source uuid:=gen_random_uuid(); ordinary_source uuid:=gen_random_uuid();
  unavailable uuid:=gen_random_uuid();
  original jsonb:='{"Date":"bad","Description":"Original","Amount":"2,00","Balance":"102,00","Fee":"0,50","Type":"Card refund","State":"COMPLETED","Merchant":"amzn","Category":" Refunds "}';
  mapping jsonb:='{"accountName":"Frozen","currencyCode":"EUR","rowContractVersion":"normalized-row-v1","numericConvention":"decimal-comma","calendarTimezone":"Europe/Berlin","rowDecisions":[{"rowNumber":2,"action":"correct","values":{"Date":"2026-09-01T10:00:00+02:00"}}]}';
  payload jsonb; ordinary_payload jsonb; reviewed public.transactions%rowtype; ordinary public.transactions%rowtype; result jsonb;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(foreign_actor,'qa-'||foreign_actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  select id into strict foreign_workspace from public.workspaces where owner_id=foreign_actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  insert into public.accounts(id,workspace_id,name,currency_code) values(foreign_account,foreign_workspace,'Foreign','EUR');
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping) values
    (imported,workspace,'synthetic.csv',workspace||'/synthetic.csv',imported::text,'queued',3,mapping),
    (ordinary_import,workspace,'ordinary.csv',workspace||'/ordinary.csv',ordinary_import::text,'queued',1,mapping);
  execute 'set local role service_role';
  perform public.prepare_import_route(imported,workspace,1,account,route_source,'Frozen','EUR',3);
  perform public.prepare_import_route(ordinary_import,workspace,1,ordinary_account,ordinary_route_source,'Ordinary','EUR',1);
  execute 'reset role';
  payload:=jsonb_build_object('accountName','Frozen','sourceId',source,'transactionId',null,'balanceId',public.stable_import_uuid(imported::text||':balance:2'),
    'rowNumber',2,'originalRow',original,'externalId','synthetic-refund','reviewReasons',jsonb_build_array('fee_semantics'),
    'feeEvidence',jsonb_build_object('feeMinor','50','treatment','included','deltaMinor','200','previousRowNumber',1),
    'postedOn','2026-09-01','postedAt','2026-09-01T08:00:00.000Z','calendarTimezone','Europe/Berlin','sourceType','Card refund','feeMinor','50',
    'description','Amazon refund','amountMinor','200','currencyCode','EUR','status','posted','kind','refund',
    'merchantName','Amazon','merchantNormalizedName','amazon','merchantId',public.stable_import_uuid(workspace::text||':merchant:amazon'),
    'categoryName','Refunds','categoryId',public.stable_import_uuid(workspace::text||':category:Refunds'),
    'balanceMinor','10200','balanceAsOf','2026-09-01T08:00:00.000Z','action','review','reportProgress',true);
  ordinary_payload:=payload||jsonb_build_object('accountName','Ordinary','sourceId',ordinary_source,'transactionId',public.stable_import_uuid(ordinary_import::text||':transaction:2'),'balanceId',public.stable_import_uuid(ordinary_import::text||':balance:2'),'action','new');
  execute 'set local role service_role';
  perform public.ingest_import_row(ordinary_import,workspace,1,ordinary_account,ordinary_payload);
  perform public.finish_import_run(ordinary_import,workspace,1,null);
  perform public.ingest_import_row(imported,workspace,1,account,payload);
  perform public.ingest_import_row(imported,workspace,1,account,payload||jsonb_build_object('sourceId',archived_source,'rowNumber',3,'balanceId',gen_random_uuid(),'status','pending'));
  perform public.ingest_import_row(imported,workspace,1,account,payload||jsonb_build_object('sourceId',missing_source,'rowNumber',4,'balanceId',gen_random_uuid(),'description','Date boundary','postedAt',null,'balanceAsOf','2026-08-31T22:00:00.000Z'));
  perform public.finish_import_run(imported,workspace,1,null);
  execute 'reset role';
  update public.accounts set name='Renamed',version=version+1 where id=account;
  insert into public.accounts(id,workspace_id,name,currency_code) values(replacement,workspace,'Frozen','EUR');
  execute 'set local role authenticated';
  begin
    perform public.resolve_import_review(source,'accept','2026-09-01','Bypass',999,'EUR');
    raise exception 'Legacy authenticated normalization bypass' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    perform public.ingest_import_row_internal(imported,workspace,1,account,payload,true);
    raise exception 'Private ingest callable' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    perform public.prepare_import_review(source,workspace,mapping,'{}',payload);
    raise exception 'Untrusted normalization callable' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  perform public.resolve_normalized_import_review(source,'accept');
  perform public.resolve_normalized_import_review(source,'accept');
  execute 'reset role';
  select t.* into strict reviewed from public.transactions t join public.transaction_sources l on l.transaction_id=t.id where l.source_transaction_id=source;
  select t.* into strict ordinary from public.transactions t join public.transaction_sources l on l.transaction_id=t.id where l.source_transaction_id=ordinary_source;
  if reviewed.account_id<>account or reviewed.account_id=replacement or
     (to_jsonb(reviewed)-array['id','account_id','created_at']) is distinct from (to_jsonb(ordinary)-array['id','account_id','created_at']) then
    raise exception 'Normalized timestamp/refund/status/currency/metadata parity or frozen UUID failed';
  end if;
  if (select count(*) from public.transaction_sources where source_transaction_id=source)<>1
    or (select original_row from public.source_transactions where id=source) is distinct from original
    or (select fee_evidence from public.source_transactions where id=source) is distinct from (select fee_evidence from public.source_transactions where id=ordinary_source)
    or not exists(select 1 from public.balance_snapshots where source_transaction_id=source and account_id=account and amount_minor=10200 and as_of='2026-09-01T08:00:00Z' and boundary_kind='after_transaction') then
    raise exception 'Original/source/fee/balance attribution parity failed';
  end if;
  update public.accounts set archived_at=now(),version=version+1 where id=account;
  execute 'set local role authenticated';
  begin
    perform public.resolve_normalized_import_review(archived_source,'accept');
    raise exception 'Archived UUID silently replaced' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    perform public.resolve_normalized_import_review(archived_source,'accept',account,foreign_account,1);
    raise exception 'Foreign explicit destination accepted' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    perform public.resolve_normalized_import_review(archived_source,'accept',replacement,replacement,1);
    raise exception 'Stale frozen route accepted' using errcode='ZX001';
  exception when serialization_failure then null; end;
  begin
    perform public.resolve_normalized_import_review(archived_source,'accept',account,replacement,99);
    raise exception 'Stale destination version accepted' using errcode='ZX001';
  exception when serialization_failure then null; end;
  perform public.resolve_normalized_import_review(archived_source,'accept',account,replacement,1);
  perform public.resolve_normalized_import_review(archived_source,'accept',account,replacement,1);
  execute 'reset role';
  if not exists(select 1 from public.transactions t join public.transaction_sources l on l.transaction_id=t.id where l.source_transaction_id=archived_source and t.account_id=replacement and t.status='pending')
    or exists(select 1 from public.balance_snapshots where source_transaction_id=archived_source) then raise exception 'Explicit pending resolution changed ingestion semantics'; end if;
  -- An unavailable UUID is never recreated or resolved by its former name.
  update public.imports set route_accounts=jsonb_build_object(jsonb_build_array('Frozen','EUR')::text,unavailable) where id=imported;
  update public.source_transactions set normalized_row=jsonb_set(normalized_row,'{accountId}',to_jsonb(unavailable)) where id=missing_source;
  execute 'set local role authenticated';
  begin
    perform public.resolve_normalized_import_review(missing_source,'accept');
    raise exception 'Unavailable frozen UUID accepted' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
  -- Poisoned/unavailable UUID is never resolved by its former name.
  update public.imports set route_accounts=jsonb_build_object(jsonb_build_array('Frozen','EUR')::text,foreign_account) where id=imported;
  update public.source_transactions set normalized_row=jsonb_set(normalized_row,'{accountId}',to_jsonb(foreign_account)) where id=missing_source;
  execute 'set local role authenticated';
  begin
    perform public.resolve_normalized_import_review(missing_source,'accept');
    raise exception 'Foreign frozen target accepted' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  perform public.resolve_normalized_import_review(missing_source,'accept',foreign_account,replacement,1);
  execute 'reset role';
  if not exists(select 1 from public.balance_snapshots where source_transaction_id=missing_source and as_of='2026-08-31T22:00:00Z' and boundary_kind='date_only') then raise exception 'Original date-only balance boundary lost'; end if;
  perform set_config('request.jwt.claim.sub',foreign_actor::text,true);
  execute 'set local role authenticated';
  if exists(select 1 from public.source_transactions where id=source) then raise exception 'Foreign RLS source visibility'; end if;
  begin
    perform public.resolve_normalized_import_review(source,'accept');
    raise exception 'Foreign workspace accepted' using errcode='ZX001';
  exception when no_data_found then null; end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  result:=public.preview_import_undo(imported);
  perform public.undo_import(imported,3,2);
  execute 'reset role';
  if exists(select 1 from public.transaction_sources where source_transaction_id in (source,archived_source,missing_source))
    or exists(select 1 from public.balance_snapshots where source_transaction_id in (source,archived_source,missing_source))
    or (select original_row from public.source_transactions where id=source) is distinct from original
    or (select count(*) from public.transactions where id=ordinary.id)<>1 then raise exception 'Undo lost source evidence or touched ordinary import'; end if;
  execute 'set local role authenticated';
  begin
    perform public.resolve_normalized_import_review(source,'accept');
    raise exception 'Undone import accepted again' using errcode='ZX001';
  exception when serialization_failure then null; end;
  execute 'reset role';
end $$;
