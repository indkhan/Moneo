do $$
declare
  actor uuid := gen_random_uuid(); workspace uuid; account uuid := gen_random_uuid(); category uuid := gen_random_uuid();
  first_id uuid; second_id uuid; entry uuid; request uuid := gen_random_uuid(); result jsonb; rows jsonb; batch uuid; other_actor uuid := gen_random_uuid();
  protected_id uuid; protected_entry uuid; import_id uuid := gen_random_uuid(); source_id uuid := gen_random_uuid(); series_id uuid := gen_random_uuid();
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Manual test','EUR');
  insert into public.categories(id,workspace_id,name) values(category,workspace,'Trips');
  result := public.create_manual_transaction(account,'2026-10-01','Exact manual expense','-9007199254740993','posted',category,'Original note',request);
  first_id := (result->>'id')::uuid; entry := (result->>'entryId')::uuid;
  if (select amount_minor from public.transactions where id=first_id)<>-9007199254740993 then raise exception 'Manual money lost precision'; end if;
  if (select original_record->>'amount_minor' from public.manual_transaction_entries where id=entry)<>'-9007199254740993' then raise exception 'Manual source money must be text'; end if;
  if public.create_manual_transaction(account,'2026-10-01','Exact manual expense','-9007199254740993','posted',category,'Original note',request)<>result then raise exception 'Manual retry duplicated entry'; end if;
  -- Old immutable records do not contain nullable columns added by later migrations.
  update public.manual_transaction_entries set original_record=original_record-'merchant_id'-'posted_at' where id=entry;
  perform public.undo_manual_transaction(entry,0,0);
  if exists(select 1 from public.transactions where id=first_id) or not exists(select 1 from public.manual_transaction_entries where id=entry and transaction_id is null and undone_at is not null and original_record->>'id'=first_id::text) then raise exception 'Undo must remove ledger entry and retain immutable source'; end if;
  begin
    perform public.restore_manual_transaction(entry,0);
    raise exception 'Stale restore accepted';
  exception when sqlstate '40001' then null; end;
  if public.restore_manual_transaction(entry,1)<>first_id then raise exception 'Restore changed original ID'; end if;
  if not exists(select 1 from public.transactions where id=first_id and amount_minor=-9007199254740993 and note='Original note') then raise exception 'Restore lost source data'; end if;
  result := public.create_manual_transaction(account,'2026-10-02','Second entry','-100','pending',null,'',gen_random_uuid());
  second_id := (result->>'id')::uuid;
  update public.transactions set version=1 where id=second_id;
  update public.transactions set review_reasons=array['source_transfer'] where id=second_id;
  rows := jsonb_build_array(jsonb_build_object('id',first_id,'version',0),jsonb_build_object('id',second_id,'version',0));
  begin
    perform public.bulk_edit_transactions(rows,'{"tags":["trip"]}',gen_random_uuid());
    raise exception 'Stale bulk edit accepted';
  exception when sqlstate '40001' then null; end;
  if exists(select 1 from public.transaction_batches where workspace_id=workspace) or exists(select 1 from public.transactions where workspace_id=workspace and tags<>'{}') then raise exception 'Stale bulk edit partially wrote'; end if;
  rows := jsonb_build_array(jsonb_build_object('id',first_id,'version',0),jsonb_build_object('id',second_id,'version',1));
  request := gen_random_uuid();
  result := public.bulk_edit_transactions(rows,jsonb_build_object('category_id',category,'tags',jsonb_build_array('Trip','weekend'),'event_name','Berlin weekend'),request);
  batch := (result->>'batchId')::uuid;
  if (select count(*) from public.transactions where workspace_id=workspace and tags=array['trip','weekend'] and event_name='Berlin weekend' and category_id=category)<>2 then raise exception 'Bulk metadata not applied'; end if;
  if not exists(select 1 from public.transactions where id=first_id and amount_minor=-9007199254740993 and note='Original note' and kind='ordinary' and status='posted') then raise exception 'Bulk editing altered financial source fields'; end if;
  if (select review_reasons from public.transactions where id=second_id)<>array['source_transfer'] then raise exception 'Bulk editing erased source review evidence'; end if;
  if public.bulk_edit_transactions(rows,jsonb_build_object('category_id',category,'tags',jsonb_build_array('Trip','weekend'),'event_name','Berlin weekend'),request)<>result then raise exception 'Bulk retry not idempotent'; end if;
  begin
    perform public.undo_manual_transaction(entry,2,1);
    raise exception 'Corrected manual evidence deleted';
  exception when sqlstate '40001' then null; end;
  begin
    perform public.undo_transaction_batch(batch,jsonb_build_array(jsonb_build_object('id',first_id,'version','1'),jsonb_build_object('id',second_id,'version',2)));
    raise exception 'String undo version accepted';
  exception when sqlstate '22023' then null; end;
  perform public.undo_transaction_batch(batch,jsonb_build_array(jsonb_build_object('id',first_id,'version',1),jsonb_build_object('id',second_id,'version',2)));
  if exists(select 1 from public.transactions where workspace_id=workspace and (tags<>'{}' or event_name is not null)) then raise exception 'Bulk undo did not restore metadata'; end if;
  if (select count(*) from public.correction_events where workspace_id=workspace and undone)<>2 then raise exception 'Bulk undo audit incomplete'; end if;
  if (select review_reasons from public.transactions where id=second_id)<>array['source_transfer'] then raise exception 'Bulk undo erased source review evidence'; end if;
  perform public.undo_transaction_batch(batch,'[]');
  result := public.create_manual_transaction(account,'2026-10-02','Protected source','-100','posted',null,'',gen_random_uuid());
  protected_id := (result->>'id')::uuid; protected_entry := (result->>'entryId')::uuid;
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash) values(import_id,workspace,'test.csv','test','test-'||import_id);
  insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row) values(source_id,workspace,import_id,1,'{"amount":"-1.00"}');
  insert into public.transaction_sources(transaction_id,source_transaction_id) values(protected_id,source_id);
  begin
    perform public.undo_manual_transaction(protected_entry,0,0);
    raise exception 'Source-backed manual evidence deleted';
  exception when sqlstate '40001' then null; end;
  delete from public.transaction_sources where transaction_id=protected_id;
  update public.transactions set refund_of_id=protected_id where id=second_id;
  begin
    perform public.undo_manual_transaction(protected_entry,0,0);
    raise exception 'Linked manual evidence deleted';
  exception when sqlstate '40001' then null; end;
  update public.transactions set refund_of_id=null where id=second_id;
  insert into public.recurring_series(id,workspace_id,account_id,label,normalized_label,cadence,currency_code,amount_min_minor,amount_max_minor,occurrences)
    values(series_id,workspace,account,'Protected','protected','monthly','EUR',-100,-100,3);
  insert into public.recurring_series_transactions(series_id,transaction_id,workspace_id) values(series_id,protected_id,workspace);
  begin
    perform public.undo_manual_transaction(protected_entry,0,0);
    raise exception 'Recurring manual evidence deleted';
  exception when sqlstate '40001' then null; end;
  if not exists(select 1 from public.transactions where id=protected_id) then raise exception 'Protected source vanished'; end if;
  begin
    perform public.bulk_edit_transactions(jsonb_build_array(jsonb_build_object('id',first_id,'version',2)),'{"amount_minor":"0"}',gen_random_uuid());
    raise exception 'Bulk arbitrary financial mutation accepted';
  exception when sqlstate '22023' then null; end;
  perform set_config('request.jwt.claim.sub',other_actor::text,true);
  begin
    perform public.create_manual_transaction(account,'2026-10-01','Foreign','-1','posted',null,'',gen_random_uuid());
    raise exception 'Foreign manual entry accepted';
  exception when sqlstate 'P0002' then null; end;
  begin
    perform public.restore_manual_transaction(entry,2);
    raise exception 'Foreign restoration accepted';
  exception when sqlstate 'P0002' then null; end;
  execute 'set local role authenticated';
  if exists(select 1 from public.manual_transaction_entries where workspace_id=workspace) or exists(select 1 from public.transaction_batches where workspace_id=workspace) then raise exception 'Foreign audit data exposed'; end if;
  execute 'reset role';
end;
$$;
