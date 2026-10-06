do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; imported uuid:=gen_random_uuid(); source uuid:=gen_random_uuid(); payload jsonb; result text;
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
end;
$$;
