do $$
declare actor uuid:=gen_random_uuid(); other_actor uuid:=gen_random_uuid(); workspace uuid; imported uuid:=gen_random_uuid(); account uuid:=gen_random_uuid(); source uuid:=gen_random_uuid(); row_source uuid:=gen_random_uuid(); transaction_id uuid:=gen_random_uuid(); balance_id uuid:=gen_random_uuid(); request_id uuid:=gen_random_uuid(); result jsonb; payload jsonb; bad_source uuid:=gen_random_uuid(); bad_transaction uuid:=gen_random_uuid(); bad_merchant uuid:=gen_random_uuid(); bad_category uuid:=gen_random_uuid(); pending_id uuid:=gen_random_uuid(); second_import uuid:=gen_random_uuid(); corrected_category uuid:=gen_random_uuid(); second_source uuid:=gen_random_uuid(); canonical_version integer;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(other_actor,'qa-'||other_actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping) values(imported,workspace,'synthetic.csv',workspace||'/synthetic.csv',imported::text,'queued',1,'{"dateColumn":"Date","descriptionColumn":"Description","amountColumn":"Amount"}');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform public.prepare_import_route(imported,workspace,1,account,source,'Synthetic import','EUR',1);
  payload:=jsonb_build_object('sourceId',row_source,'transactionId',transaction_id,'balanceId',balance_id,'rowNumber',2,'originalRow',jsonb_build_object('Amount','-90071992547409.93'),'externalId','synthetic-1','postedOn','2026-10-01','postedAt','2026-10-01T08:00:00Z','description','Synthetic exact row','amountMinor','-9007199254740993','currencyCode','EUR','status','posted','kind','ordinary','reviewReasons','[]'::jsonb,'action','new','balanceMinor','10000','balanceAsOf','2026-10-01T08:00:00Z');
  update public.accounts set archived_at=now() where id=account;
  begin
    perform public.ingest_import_row(imported,workspace,1,account,payload);
    raise exception 'Archived target accepted import effects' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  if exists(select 1 from public.source_transactions where id=row_source) or exists(select 1 from public.transactions where id=transaction_id) then raise exception 'Archived account refusal retained row effects'; end if;
  update public.accounts set archived_at=null where id=account;
  result:=public.ingest_import_row(imported,workspace,1,account,payload);
  if result->>'action'<>'new' or not exists(select 1 from public.transactions where id=transaction_id and amount_minor=-9007199254740993) then raise exception 'Exact import row missing'; end if;
  begin
    perform public.ingest_import_row(imported,workspace,1,account,payload||jsonb_build_object('sourceId',bad_source,'transactionId',bad_transaction,'balanceId',gen_random_uuid(),'rowNumber',3,'description','Synthetic rollback row','merchantName','Atomic failure merchant','merchantId',bad_merchant,'categoryName','Atomic failure category','categoryId',bad_category,'balanceMinor','9223372036854775808'));
    raise exception 'Invalid snapshot committed partial row effects' using errcode='ZX001';
  exception when numeric_value_out_of_range then null; end;
  if exists(select 1 from public.source_transactions where id=bad_source) or exists(select 1 from public.transactions where id=bad_transaction) or exists(select 1 from public.merchants where id=bad_merchant) or exists(select 1 from public.categories where id=bad_category) then raise exception 'Atomic row failure retained ancillary or financial writes'; end if;
  execute 'set local role authenticated';
  result:=public.control_import(imported,'cancel',request_id);
  if result->>'status'<>'canceled' then raise exception 'Import cancellation missing'; end if;
  result:=public.control_import(imported,'cancel',request_id);
  if (result->>'started')::boolean then raise exception 'Repeated cancellation repeated work'; end if;
  begin
    perform public.prepare_import_route(imported,workspace,1,gen_random_uuid(),gen_random_uuid(),'Forbidden late account','EUR',2);
    raise exception 'Authenticated caller ingested' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
  update public.accounts set name='Renamed synthetic account' where id=account;
  begin
    perform public.ingest_import_row(imported,workspace,1,account,payload||jsonb_build_object('rowNumber',3,'sourceId',gen_random_uuid(),'transactionId',gen_random_uuid()));
    raise exception 'Canceled import wrote a row' using errcode='ZX001';
  exception when query_canceled then null; end;
  if (select count(*) from public.source_transactions where import_id=imported)<>1 then raise exception 'Canceled import lost or added sources'; end if;
  execute 'set local role authenticated';
  result:=public.control_import(imported,'resume',gen_random_uuid());
  if (result->>'runVersion')::integer<>3 or (result->>'started')::boolean is distinct from true then raise exception 'Resume did not establish a new boundary'; end if;
  perform set_config('request.jwt.claim.sub',other_actor::text,true);
  begin
    perform public.control_import(imported,'cancel',gen_random_uuid());
    raise exception 'Foreign import controlled' using errcode='ZX001';
  exception when no_data_found then null; end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',actor::text,true);
  begin
    perform public.prepare_import_route(imported,workspace,1,account,source,'Synthetic import','EUR',1);
    raise exception 'Old worker resumed after cancellation' using errcode='ZX001';
  exception when query_canceled then null; end;
  perform public.prepare_import_route(imported,workspace,3,account,source,'Synthetic import','EUR',1);
  perform public.ingest_import_row(imported,workspace,3,account,payload);
  if (select count(*) from public.transactions where id=transaction_id)<>1 or (select count(*) from public.balance_snapshots where id=balance_id)<>1 or (select count(*) from public.source_transactions where import_id=imported)<>1 then raise exception 'Resume duplicated ledger, source or balance'; end if;
  perform public.finish_import_run(imported,workspace,3,null);
  if (select status from public.imports where id=imported)<>'completed' then raise exception 'Resume did not finish'; end if;
  insert into public.categories(id,workspace_id,name) values(corrected_category,workspace,'Reviewed canonical category');
  update public.transactions set kind='transfer',category_id=corrected_category,version=version+1 where id=transaction_id;
  select version into canonical_version from public.transactions where id=transaction_id;
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping) values(second_import,workspace,'synthetic-duplicate.csv',workspace||'/duplicate.csv',second_import::text,'queued',1,'{"dateColumn":"Date","descriptionColumn":"Description","amountColumn":"Amount"}');
  perform public.prepare_import_route(second_import,workspace,1,account,source,'Renamed synthetic account','EUR',1);
  begin
    perform public.ingest_import_row(second_import,workspace,1,account,payload||jsonb_build_object('sourceId',second_source,'transactionId',gen_random_uuid(),'balanceId',gen_random_uuid(),'action','new'));
    raise exception 'Stale new overlap created another canonical' using errcode='ZX001';
  exception when serialization_failure then null; end;
  if exists(select 1 from public.source_transactions where id=second_source) then raise exception 'Stale overlap retained source effects'; end if;
  begin
    perform public.ingest_import_row(second_import,workspace,1,account,payload||jsonb_build_object('sourceId',second_source,'balanceId',gen_random_uuid(),'action','matched','expectedTransactionVersion',canonical_version-1));
    raise exception 'Stale canonical match accepted' using errcode='ZX001';
  exception when serialization_failure then null; end;
  if exists(select 1 from public.source_transactions where id=second_source) then raise exception 'Stale match wrote source effects'; end if;
  perform public.ingest_import_row(second_import,workspace,1,account,payload||jsonb_build_object('sourceId',second_source,'balanceId',gen_random_uuid(),'action','matched','expectedTransactionVersion',canonical_version));
  if not exists(select 1 from public.transactions where id=transaction_id and kind='transfer' and category_id=corrected_category and amount_minor=-9007199254740993) then raise exception 'Stable match overwrote canonical correction'; end if;
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping) values(pending_id,workspace,'unconfirmed.csv',workspace||'/unconfirmed.csv',pending_id::text,'pending',1,'{"dateColumn":"Date","descriptionColumn":"Description"}');
  execute 'set local role authenticated';
  perform public.control_import(pending_id,'cancel',gen_random_uuid());
  begin
    perform public.control_import(pending_id,'resume',gen_random_uuid());
    raise exception 'Unconfirmed pending import resumed' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
  execute 'reset role';
end;
$$;
