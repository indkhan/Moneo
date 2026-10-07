do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; imported uuid:=gen_random_uuid(); account uuid:=gen_random_uuid(); other_workspace uuid;
  payload jsonb; staged jsonb; candidate jsonb; result jsonb; route_source uuid:=gen_random_uuid(); second_import uuid:=gen_random_uuid(); version integer;
begin
  insert into auth.users(id,email) values(actor,'qa-batch-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping)
    values(imported,workspace,'batch.csv',workspace||'/batch.csv',imported::text,'queued',2,
      '{"rowContractVersion":"normalized-row-v1","rowDecisions":[{"rowNumber":3,"action":"exclude","reason":"Footer"}]}');
  perform public.prepare_import_route(imported,workspace,1,account,route_source,'Batch Checking','EUR',2);
  payload:=jsonb_build_object('accountName','Batch Checking','sourceId',public.stable_import_uuid(imported::text||':row:2'),'rowNumber',2,
    'balanceId',public.stable_import_uuid(imported::text||':balance:2'),'originalRow',jsonb_build_object('Amount','90071992547409.93','Date','original before correction'),
    'externalId','batch-stable-external','postedOn','2026-10-01','postedAt',null,'description','Batch exact synthetic','amountMinor','9007199254740993','currencyCode','EUR','status','posted','kind','ordinary','reviewReasons','[]'::jsonb);
  staged:=jsonb_build_array(jsonb_build_object('accountId',account,'excluded',false,'row',payload),jsonb_build_object('accountId',null,'excluded',true,'row',
    jsonb_build_object('sourceId',public.stable_import_uuid(imported::text||':row:3'),'rowNumber',3,'originalRow',jsonb_build_object('Amount','bad'),'reason','Footer')));
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  begin perform public.stage_import_rows(imported,workspace,1,imported::text,staged); raise exception 'Authenticated staged rows' using errcode='ZX001'; exception when insufficient_privilege then null; end;
  begin perform public.import_batch_candidates(imported,workspace,1,0); raise exception 'Authenticated prefetched candidates' using errcode='ZX001'; exception when insufficient_privilege then null; end;
  begin perform public.ingest_import_batch(imported,workspace,1,0,'[]'); raise exception 'Authenticated ingested batch' using errcode='ZX001'; exception when insufficient_privilege then null; end;
  execute 'reset role';
  begin perform public.stage_import_rows(imported,workspace,1,'changed',staged); raise exception 'Wrong hash staged' using errcode='ZX001'; exception when invalid_parameter_value then null; end;
  perform public.stage_import_rows(imported,workspace,1,imported::text,staged);
  perform public.stage_import_rows(imported,workspace,1,imported::text,staged);
  begin perform public.stage_import_rows(imported,workspace,1,imported::text,jsonb_set(staged,'{0,row,description}','"changed"')); raise exception 'Staging was replaced' using errcode='ZX001'; exception when serialization_failure then null; end;
  begin update public.import_staging set rows=staged where import_id=imported; raise exception 'Staging was updated' using errcode='ZX001'; exception when invalid_parameter_value then null; end;
  candidate:=public.import_batch_candidates(imported,workspace,1,0);
  if candidate->0->'candidates'<>'[]'::jsonb then raise exception 'Fresh synthetic batch overlaps'; end if;
  -- An extra/missing decision causes the whole transaction to roll back, even
  -- after earlier rows/exclusions were attempted.
  begin perform public.ingest_import_batch(imported,workspace,1,0,'[{"rowNumber":2,"action":"new"},{"rowNumber":4,"action":"new"}]'); raise exception 'Extra batch row accepted' using errcode='ZX001'; exception when invalid_parameter_value then null; end;
  if exists(select 1 from public.source_transactions where import_id=imported) then raise exception 'Failed batch left partial source effects'; end if;
  result:=public.ingest_import_batch(imported,workspace,1,0,'[{"rowNumber":2,"action":"new"}]');
  if result->>'newRows'<>'1' or result->>'rejectedRows'<>'1' then raise exception 'Batch progress differs'; end if;
  perform public.ingest_import_batch(imported,workspace,1,0,'[{"rowNumber":2,"action":"new"}]');
  if (select count(*) from public.source_transactions where import_id=imported)<>2 or (select count(*) from public.transactions where workspace_id=workspace)<>1
    or not exists(select 1 from public.transactions where workspace_id=workspace and amount_minor=9007199254740993)
    or not exists(select 1 from public.source_transactions where import_id=imported and original_row=payload->'originalRow' and normalized_row->'row'=payload) then raise exception 'Batch retry changed financial/source evidence'; end if;
  update public.imports set status='canceled' where id=imported;
  begin perform public.import_batch_candidates(imported,workspace,1,0); raise exception 'Canceled batch prefetched' using errcode='ZX001'; exception when query_canceled then null; end;
  begin perform public.ingest_import_batch(imported,workspace,1,0,'[{"rowNumber":2,"action":"new"}]'); raise exception 'Canceled batch posted' using errcode='ZX001'; exception when query_canceled then null; end;
  update public.imports set status='running',run_version=2 where id=imported;
  begin perform public.ingest_import_batch(imported,workspace,1,0,'[{"rowNumber":2,"action":"new"}]'); raise exception 'Old batch worker posted' using errcode='ZX001'; exception when query_canceled then null; end;
  perform public.ingest_import_batch(imported,workspace,2,0,'[{"rowNumber":2,"action":"new"}]');
  perform public.finish_import_run(imported,workspace,2,null);
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping)
    values(second_import,workspace,'overlap.csv',workspace||'/overlap.csv',second_import::text,'queued',1,'{"rowContractVersion":"normalized-row-v1"}');
  perform public.prepare_import_route(second_import,workspace,1,account,route_source,'Batch Checking','EUR',1);
  payload:=payload||jsonb_build_object('sourceId',public.stable_import_uuid(second_import::text||':row:2'),'balanceId',public.stable_import_uuid(second_import::text||':balance:2'));
  perform public.stage_import_rows(second_import,workspace,1,second_import::text,jsonb_build_array(jsonb_build_object('accountId',account,'excluded',false,'row',payload)));
  candidate:=public.import_batch_candidates(second_import,workspace,1,0);
  if candidate->0->'candidates'->0->>'externalId'<>'batch-stable-external' then raise exception 'Batch stable matching evidence differs'; end if;
  version:=(candidate->0->'candidates'->0->>'version')::integer;
  begin perform public.ingest_import_batch(second_import,workspace,1,0,jsonb_build_array(jsonb_build_object('rowNumber',2,'action','matched','transactionId',candidate->0->'candidates'->0->>'id','expectedTransactionVersion',version+1))); raise exception 'Stale match posted' using errcode='ZX001'; exception when serialization_failure then null; end;
  perform public.ingest_import_batch(second_import,workspace,1,0,jsonb_build_array(jsonb_build_object('rowNumber',2,'action','matched','transactionId',candidate->0->'candidates'->0->>'id','expectedTransactionVersion',version)));
  if (select count(*) from public.transactions where workspace_id=workspace)<>1 or (select matched_rows from public.imports where id=second_import)<>1 then raise exception 'Batch overlap duplicated canonical posting'; end if;
  update public.imports set mapping=mapping||'{"changed":true}'::jsonb where id=second_import;
  begin perform public.read_import_stage(second_import,workspace,1); raise exception 'Changed interpretation replayed' using errcode='ZX001'; exception when serialization_failure then null; end;
  update public.imports set mapping=mapping-'changed' where id=second_import;
  perform public.finish_import_run(second_import,workspace,1,null);
  execute 'set local role authenticated';
  perform public.undo_import(second_import,0,0);
  begin perform public.undo_import(imported,1,0); raise exception 'Shared canonical undo bypassed existing guard' using errcode='ZX001'; exception when serialization_failure then null; end;
  execute 'reset role';
  if (select count(*) from public.source_transactions where import_id in(imported,second_import))<>3
    or (select count(*) from public.import_staging where import_id in(imported,second_import))<>2 then raise exception 'Undo erased immutable batch/source history'; end if;
end;
$$;
