do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; account uuid:=gen_random_uuid(); route_source uuid:=gen_random_uuid();
  first_import uuid:=gen_random_uuid(); second_import uuid:=gen_random_uuid(); rows_total constant integer:=501;
  base jsonb; staged jsonb; candidate jsonb; decisions jsonb; version integer; batch_offset integer; got record; want record; checked integer:=0;
begin
  insert into auth.users(id,email) values(actor,'qa-batch-progress-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  base:=jsonb_build_object('accountName','Progress Checking','externalId','progress-stable-external','postedOn','2026-10-01','postedAt',null,'description','Progress matched synthetic',
    'amountMinor','-1500','currencyCode','EUR','status','posted','kind','ordinary','reviewReasons','[]'::jsonb);

  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping)
    values(first_import,workspace,'first.csv',workspace||'/first.csv',first_import::text,'queued',1,'{"rowContractVersion":"normalized-row-v1"}');
  perform public.prepare_import_route(first_import,workspace,1,account,route_source,'Progress Checking','EUR',1);
  perform public.stage_import_rows(first_import,workspace,1,first_import::text,(select mapping from public.imports where id=first_import),(select route_accounts from public.imports where id=first_import),(select source_id from public.imports where id=first_import),
    jsonb_build_array(jsonb_build_object('accountId',account,'excluded',false,'row',base||jsonb_build_object('sourceId',public.stable_import_uuid(first_import::text||':row:2'),'balanceId',public.stable_import_uuid(first_import::text||':balance:2'),'rowNumber',2,'originalRow',jsonb_build_object('Amount','-15.00')))));
  perform public.ingest_import_batch(first_import,workspace,1,0,'[{"rowNumber":2,"action":"new"}]');
  perform public.finish_import_run(first_import,workspace,1,null);

  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping)
    values(second_import,workspace,'second.csv',workspace||'/second.csv',second_import::text,'queued',rows_total,
      '{"rowContractVersion":"normalized-row-v1","rowDecisions":[{"rowNumber":3,"action":"exclude","reason":"Footer"},{"rowNumber":502,"action":"exclude","reason":"Footer"}]}');
  perform public.prepare_import_route(second_import,workspace,1,account,route_source,'Progress Checking','EUR',rows_total);
  select jsonb_agg(case when n in (3,502) then jsonb_build_object('accountId',null,'excluded',true,'row',jsonb_build_object('sourceId',public.stable_import_uuid(second_import::text||':row:'||n),'rowNumber',n,'originalRow',jsonb_build_object('Amount','footer'),'reason','Footer'))
    else jsonb_build_object('accountId',account,'excluded',false,'row',
      case when n=2 then base else base||jsonb_build_object('externalId',null,'description','Progress synthetic '||n,'postedOn',('2026-09-01'::date-n%200)::text,'amountMinor',(-100-n)::text) end
      ||case when n=5 then jsonb_build_object('reviewReasons','["source_type"]'::jsonb) else '{}'::jsonb end
      ||jsonb_build_object('sourceId',public.stable_import_uuid(second_import::text||':row:'||n),'balanceId',public.stable_import_uuid(second_import::text||':balance:'||n),'rowNumber',n,'originalRow',jsonb_build_object('Amount',n::text))) end order by n)
    into staged from generate_series(2,rows_total+1) n;
  perform public.stage_import_rows(second_import,workspace,1,second_import::text,(select mapping from public.imports where id=second_import),(select route_accounts from public.imports where id=second_import),(select source_id from public.imports where id=second_import),staged);

  for batch_offset in 0..500 by 250 loop
    candidate:=public.import_batch_candidates(second_import,workspace,1,batch_offset);
    select jsonb_agg(case
      when (c->>'rowNumber')::integer=2 then jsonb_build_object('rowNumber',2,'action','matched','transactionId',c->'candidates'->0->>'id','expectedTransactionVersion',(c->'candidates'->0->>'version')::integer)
      when (c->>'rowNumber')::integer in (4,300) then jsonb_build_object('rowNumber',(c->>'rowNumber')::integer,'action','review')
      else jsonb_build_object('rowNumber',(c->>'rowNumber')::integer,'action','new') end) into decisions from jsonb_array_elements(candidate) c;
    perform public.ingest_import_batch(second_import,workspace,1,batch_offset,coalesce(decisions,'[]'));
    select new_rows,matched_rows,review_rows,rejected_rows,classification_review_rows into got from public.imports where id=second_import;
    perform public.recount_import_progress(second_import);
    select new_rows,matched_rows,review_rows,rejected_rows,classification_review_rows into want from public.imports where id=second_import;
    if got is distinct from want then raise exception 'Progress after the batch at offset % was % but a full recount gives %',batch_offset,got,want; end if;
    perform public.ingest_import_batch(second_import,workspace,1,batch_offset,coalesce(decisions,'[]'));
    select new_rows,matched_rows,review_rows,rejected_rows,classification_review_rows into got from public.imports where id=second_import;
    if got is distinct from want then raise exception 'Retrying the batch at offset % changed progress from % to %',batch_offset,want,got; end if;
    checked:=checked+1;
  end loop;

  if checked<>3 or want.new_rows<>rows_total-5 or want.matched_rows<>1 or want.review_rows<>2 or want.rejected_rows<>2 or want.classification_review_rows<>1 then
    raise exception 'Progress counts missed a kind of row: %',want;
  end if;
  perform public.finish_import_run(second_import,workspace,1,null);
end;
$$;
