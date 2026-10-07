-- Simulate a privileged edit after normalization, retaining hash, routes,
-- coverage and run version. The stale values must never acquire the new mapping.
do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; imported uuid:=gen_random_uuid(); account uuid:=gen_random_uuid(); source uuid:=gen_random_uuid();
  snapshot_mapping jsonb:='{"rowContractVersion":"normalized-row-v1","amountSign":"signed"}'; routes jsonb; snapshot_rows jsonb;
begin
  insert into auth.users(id,email) values(actor,'qa-stage-snapshot-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping)
    values(imported,workspace,'snapshot.csv',workspace||'/snapshot.csv',imported::text,'queued',1,snapshot_mapping);
  perform public.prepare_import_route(imported,workspace,1,account,source,'Snapshot Checking','EUR',1);
  select route_accounts into routes from public.imports where id=imported;
  snapshot_rows:=jsonb_build_array(jsonb_build_object('accountId',account,'excluded',false,'row',jsonb_build_object(
    'accountName','Snapshot Checking','sourceId',public.stable_import_uuid(imported::text||':row:2'),'rowNumber',2,
    'originalRow',jsonb_build_object('Amount','90071992547409.93'),'postedOn','2026-10-01','description','Snapshot exact synthetic',
    'amountMinor','9007199254740993','currencyCode','EUR','status','posted','kind','ordinary','reviewReasons','[]'::jsonb)));
  update public.imports set mapping=jsonb_set(mapping,'{amountSign}','"outflow-positive"') where id=imported;
  begin
    perform public.stage_import_rows(imported,workspace,1,imported::text,snapshot_mapping,routes,source,snapshot_rows);
    raise exception 'Privileged normalization mapping drift staged stale financial values' using errcode='ZX001';
  exception when serialization_failure then null; end;
  if exists(select 1 from public.import_staging where import_id=imported) or exists(select 1 from public.source_transactions where import_id=imported)
    or exists(select 1 from public.transactions where workspace_id=workspace) then raise exception 'Rejected snapshot left financial/staging effects'; end if;
  update public.imports set mapping=mapping-'amountSign'||'{"amountSign":"signed"}'::jsonb where id=imported;
  update public.imports set route_accounts='{}' where id=imported;
  begin perform public.stage_import_rows(imported,workspace,1,imported::text,snapshot_mapping,routes,source,snapshot_rows); raise exception 'Changed route snapshot staged' using errcode='ZX001'; exception when serialization_failure then null; end;
  update public.imports set route_accounts=routes,source_id=null where id=imported;
  begin perform public.stage_import_rows(imported,workspace,1,imported::text,snapshot_mapping,routes,source,snapshot_rows); raise exception 'Changed legacy source identity staged' using errcode='ZX001'; exception when serialization_failure then null; end;
  update public.imports set source_id=source where id=imported;
  perform public.stage_import_rows(imported,workspace,1,imported::text,snapshot_mapping,routes,source,snapshot_rows);
  perform public.stage_import_rows(imported,workspace,1,imported::text,snapshot_mapping,routes,source,snapshot_rows);
  if not exists(select 1 from public.import_staging where import_id=imported and rows=snapshot_rows and mapping=snapshot_mapping) then raise exception 'Unchanged snapshot retry differs'; end if;
  perform public.ingest_import_batch(imported,workspace,1,0,'[{"rowNumber":2,"action":"new"}]');
  perform public.ingest_import_batch(imported,workspace,1,0,'[{"rowNumber":2,"action":"new"}]');
  if (select count(*) from public.transactions where workspace_id=workspace)<>1
    or (select count(*) from public.source_transactions where import_id=imported)<>1
    or not exists(select 1 from public.transactions where workspace_id=workspace and amount_minor=9007199254740993)
    or not exists(select 1 from public.source_transactions where import_id=imported and original_row=snapshot_rows->0->'row'->'originalRow') then raise exception 'Unchanged retry altered exact money/source evidence'; end if;
end;
$$;
