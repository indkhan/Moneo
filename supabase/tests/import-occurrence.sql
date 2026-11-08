-- Banks without transaction IDs: overlaps are compared by occurrence count, within a complete bank window only.
do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; first_import uuid:=gen_random_uuid(); second_import uuid:=gen_random_uuid(); file_import uuid:=gen_random_uuid(); account uuid:=gen_random_uuid(); route_source uuid:=gen_random_uuid();
  candidates jsonb; rows jsonb; canonical uuid; row_payload jsonb; version integer;
begin
  insert into auth.users(id,email) values(actor,'qa-occurrence-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping)
    values(first_import,workspace,'first.csv',workspace||'/first.csv',first_import::text,'queued',1,'{"rowContractVersion":"normalized-row-v1","completeWindow":true}');
  perform public.prepare_import_route(first_import,workspace,1,account,route_source,'Occurrence Bank','EUR',1);
  row_payload:=jsonb_build_object('accountName','Occurrence Bank','sourceId',public.stable_import_uuid(first_import::text||':row:2'),'rowNumber',2,'balanceId',public.stable_import_uuid(first_import::text||':balance:2'),
    'originalRow',jsonb_build_object('Amount','-5'),'externalId',null,'postedOn','2026-10-01','postedAt',null,'description','Same coffee','amountMinor','-500','currencyCode','EUR','status','posted','kind','ordinary','reviewReasons','[]'::jsonb);
  perform public.stage_import_rows(first_import,workspace,1,first_import::text,(select mapping from public.imports where id=first_import),(select route_accounts from public.imports where id=first_import),(select source_id from public.imports where id=first_import),
    jsonb_build_array(jsonb_build_object('accountId',account,'excluded',false,'row',row_payload)));
  perform public.ingest_import_batch(first_import,workspace,1,0,'[{"rowNumber":2,"action":"new"}]');
  select id,t.version into strict canonical,version from public.transactions t where workspace_id=workspace;

  -- The bank now states two identical rows: the first repeats the ledger, the second is a real second payment.
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping)
    values(second_import,workspace,'second.csv',workspace||'/second.csv',second_import::text,'queued',2,'{"rowContractVersion":"normalized-row-v1","completeWindow":true}');
  perform public.prepare_import_route(second_import,workspace,1,account,route_source,'Occurrence Bank','EUR',2);
  rows:=jsonb_build_array(
    jsonb_build_object('accountId',account,'excluded',false,'row',row_payload||jsonb_build_object('sourceId',public.stable_import_uuid(second_import::text||':row:2'),'balanceId',public.stable_import_uuid(second_import::text||':balance:2'),'rowNumber',2)),
    jsonb_build_object('accountId',account,'excluded',false,'row',row_payload||jsonb_build_object('sourceId',public.stable_import_uuid(second_import::text||':row:3'),'balanceId',public.stable_import_uuid(second_import::text||':balance:3'),'rowNumber',3)));
  perform public.stage_import_rows(second_import,workspace,1,second_import::text,(select mapping from public.imports where id=second_import),(select route_accounts from public.imports where id=second_import),(select source_id from public.imports where id=second_import),rows);
  candidates:=public.import_batch_candidates(second_import,workspace,1,0);
  if candidates->0->'occurrence'<>'{"index":1,"total":2}'::jsonb or candidates->1->'occurrence'<>'{"index":2,"total":2}'::jsonb then raise exception 'Occurrences differ: %',candidates; end if;
  -- Claiming a new row while the ledger already has as many as this one's position must fail.
  begin
    perform public.ingest_import_batch(second_import,workspace,1,0,jsonb_build_array(jsonb_build_object('rowNumber',2,'action','new','occurrenceIndex',1),jsonb_build_object('rowNumber',3,'action','new','occurrenceIndex',2)));
    raise exception 'A repeat was posted twice' using errcode='ZX001';
  exception when sqlstate 'PT409' then null; end;
  perform public.ingest_import_batch(second_import,workspace,1,0,jsonb_build_array(jsonb_build_object('rowNumber',2,'action','matched','transactionId',canonical,'expectedTransactionVersion',version,'occurrenceIndex',1),jsonb_build_object('rowNumber',3,'action','new','occurrenceIndex',2)));
  if (select count(*) from public.transactions where workspace_id=workspace)<>2 then raise exception 'Expected the repeat matched and the second payment landed'; end if;
  if (select status from public.source_transactions where import_id=second_import and row_number=2)<>'matched' then raise exception 'The repeat was not matched'; end if;
  if (select count(*) from public.transaction_sources where transaction_id=canonical)<>2 then raise exception 'The repeat lost its source link'; end if;

  -- A file promises nothing: no occurrence evidence, and a claim of one is refused.
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping)
    values(file_import,workspace,'file.csv',workspace||'/file.csv',file_import::text,'queued',1,'{"rowContractVersion":"normalized-row-v1"}');
  perform public.prepare_import_route(file_import,workspace,1,account,route_source,'Occurrence Bank','EUR',1);
  perform public.stage_import_rows(file_import,workspace,1,file_import::text,(select mapping from public.imports where id=file_import),(select route_accounts from public.imports where id=file_import),(select source_id from public.imports where id=file_import),
    jsonb_build_array(jsonb_build_object('accountId',account,'excluded',false,'row',row_payload||jsonb_build_object('sourceId',public.stable_import_uuid(file_import::text||':row:2'),'balanceId',public.stable_import_uuid(file_import::text||':balance:2')))));
  if (public.import_batch_candidates(file_import,workspace,1,0))->0 ? 'occurrence' then raise exception 'A file was treated as a complete window'; end if;
  begin
    perform public.ingest_import_batch(file_import,workspace,1,0,jsonb_build_array(jsonb_build_object('rowNumber',2,'action','new','occurrenceIndex',3)));
    raise exception 'A file claimed occurrence evidence' using errcode='ZX001';
  exception when invalid_parameter_value then null; end;
end;
$$;
