do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; imported uuid:=gen_random_uuid(); source uuid:=gen_random_uuid(); payload jsonb; result text;
  reviewed_import uuid:=gen_random_uuid(); account uuid:=gen_random_uuid(); route_source uuid:=gen_random_uuid(); overlap uuid:=gen_random_uuid(); footer uuid:=gen_random_uuid(); original jsonb;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping)
    values(imported,workspace,'synthetic.csv',workspace||'/synthetic.csv',imported::text,'queued',1,
      '{"rowContractVersion":"normalized-row-v1","rowDecisions":[{"rowNumber":2,"action":"exclude","reason":"Statement footer"}]}');
  payload:=jsonb_build_object('sourceId',source,'rowNumber',2,'reason','Statement footer','originalRow',jsonb_build_object('Date','','Description','Footer','Amount','bad'));
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  begin
    perform public.record_import_exclusion(imported,workspace,1,payload);
    raise exception 'Authenticated caller recorded a source exclusion' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
  execute 'set local role service_role';
  perform public.record_import_exclusion(imported,workspace,1,payload);
  perform public.record_import_exclusion(imported,workspace,1,payload);
  execute 'reset role';
  if (select count(*) from public.source_transactions where import_id=imported)<>1
    or not exists(select 1 from public.source_transactions where id=source and status='rejected' and original_row=payload->'originalRow' and review_reasons=array['excluded_by_review'])
    or (select rejected_rows from public.imports where id=imported)<>1
    or exists(select 1 from public.transaction_sources where source_transaction_id=source) then
    raise exception 'Excluded source evidence, counts or idempotency differ';
  end if;
  begin
    perform public.record_import_exclusion(imported,workspace,1,payload||jsonb_build_object('reason','Unreviewed reason'));
    raise exception 'Unreviewed exclusion reason accepted' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.record_import_exclusion(imported,workspace,1,payload||jsonb_build_object('originalRow',jsonb_build_object('Amount','changed')));
    raise exception 'Excluded original evidence overwritten' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  update public.imports set status='canceled' where id=imported;
  begin
    perform public.record_import_exclusion(imported,workspace,1,payload);
    raise exception 'Canceled worker recorded exclusion' using errcode='ZX001';
  exception when query_canceled then null; end;
  update public.imports set status='running',run_version=2 where id=imported;
  begin
    perform public.record_import_exclusion(imported,workspace,1,payload);
    raise exception 'Superseded worker recorded exclusion' using errcode='ZX001';
  exception when query_canceled then null; end;
  result:=public.finish_import_run(imported,workspace,2,null);
  if result<>'completed' then raise exception 'All-excluded source coverage could not finish'; end if;
  execute 'set local role authenticated';
  perform public.undo_import(imported,0,0);
  execute 'reset role';
  if (select status from public.imports where id=imported)<>'undone'
    or (select original_row from public.source_transactions where id=source) is distinct from payload->'originalRow' then
    raise exception 'Undo erased excluded source history';
  end if;
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping)
    values(reviewed_import,workspace,'synthetic-review.csv',workspace||'/review.csv',reviewed_import::text,'queued',2,
      '{"accountName":"Reviewed synthetic","currencyCode":"EUR","currencyColumn":"Currency","statusColumn":"State","typeColumn":"Type","merchantColumn":"Merchant","categoryColumn":"Category","rowContractVersion":"normalized-row-v1","rowDecisions":[{"rowNumber":2,"action":"correct","values":{"Currency":"EUR","State":"pending","Type":"Card refund","Merchant":"IKEA","Category":"Reviewed"}},{"rowNumber":3,"action":"exclude","reason":"Statement footer"}]}');
  perform public.prepare_import_route(reviewed_import,workspace,1,account,route_source,'Reviewed synthetic','EUR',2);
  original:=jsonb_build_object('Currency','USD','State','unsupported','Type','Transfer','Merchant','Amazon','Category','Original');
  payload:=jsonb_build_object('sourceId',overlap,'transactionId',null,'balanceId',gen_random_uuid(),'rowNumber',2,'originalRow',original,'postedOn','2026-09-02','description','Reviewed refund','amountMinor','200','currencyCode','EUR','status','pending','kind','refund','reviewReasons','[]'::jsonb,'action','review');
  perform public.ingest_import_row(reviewed_import,workspace,1,account,payload);
  perform public.record_import_exclusion(reviewed_import,workspace,1,jsonb_build_object('sourceId',footer,'rowNumber',3,'reason','Statement footer','originalRow',jsonb_build_object('Description','Footer')));
  perform public.finish_import_run(reviewed_import,workspace,1,null);
  insert into public.merchants(id,workspace_id,name,normalized_name) values(gen_random_uuid(),workspace,'IKEA','ikea');
  insert into public.categories(id,workspace_id,name) values(gen_random_uuid(),workspace,'Reviewed');
  execute 'set local role authenticated';
  perform public.resolve_import_review(overlap,'accept','2026-09-02','Reviewed refund',200,'EUR');
  perform public.resolve_import_review(overlap,'accept','2026-09-02','Reviewed refund',200,'EUR');
  begin
    perform public.reviewed_import_source_row(overlap);
    raise exception 'Private reviewed-source helper callable directly' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
  if not exists(select 1 from public.transactions t join public.transaction_sources l on l.transaction_id=t.id
      join public.merchants m on m.id=t.merchant_id join public.categories c on c.id=t.category_id
      where l.source_transaction_id=overlap and t.currency_code='EUR' and t.status='pending' and t.kind='refund' and m.name='IKEA' and c.name='Reviewed')
    or (select count(*) from public.transaction_sources where source_transaction_id=overlap)<>1
    or (select original_row from public.source_transactions where id=overlap) is distinct from original
    or not exists(select 1 from public.imports where id=reviewed_import and new_rows=1 and review_rows=0 and rejected_rows=1) then
    raise exception 'Corrected overlap acceptance changed interpretation, original evidence, coverage or retry identity';
  end if;
end;
$$;
