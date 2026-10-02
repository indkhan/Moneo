-- Classification preserves booked money; every fixture is rolled back by the runner.
do $$
declare
  actor uuid := gen_random_uuid();
  workspace uuid;
  account uuid := gen_random_uuid();
  imported uuid := gen_random_uuid();
  source uuid := gen_random_uuid();
  transaction uuid := gen_random_uuid();
  result jsonb;
  event uuid;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Synthetic classification','EUR');
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,mapping) values(imported,workspace,'synthetic.csv','synthetic',imported::text,'completed','{}');
  insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row,status,review_reasons)
    values(source,workspace,imported,2,'{"Type":"Transfer","Fee":"1.00"}','new',array['source_transfer','fee_semantics']);
  insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,review_reasons)
    values(transaction,workspace,account,'2026-10-01','Synthetic classification',-1000,'EUR',array['source_transfer','fee_semantics']);
  insert into public.transaction_sources(transaction_id,source_transaction_id) values(transaction,source);
  perform public.recount_import_progress(imported);
  if not exists(select 1 from public.imports where id=imported and new_rows=1 and classification_review_rows=1) then raise exception 'Progress recount failed'; end if;
  begin
    perform public.resolve_transaction_classification(transaction,0,'ordinary',false);
    raise exception 'Unknown fee must remain under review' using errcode='ZX001';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.resolve_transaction_classification(transaction,null,'ordinary',true);
    raise exception 'Missing expected version bypassed concurrency' using errcode='ZX001';
  exception when sqlstate '22023' then null; end;
  result := public.resolve_transaction_classification(transaction,0,'ordinary',true);
  event := (result->>'eventId')::uuid;
  if not exists(select 1 from public.transactions where id=transaction and amount_minor=-1000 and version=1 and cardinality(review_reasons)=0) then raise exception 'Resolution altered booked money or failed to clear review'; end if;
  if (select classification_review_rows from public.imports where id=imported) <> 0 then raise exception 'Resolved progress remains stale'; end if;
  begin
    perform public.undo_transaction_classification(event,null);
    raise exception 'Missing undo version bypassed concurrency' using errcode='ZX001';
  exception when sqlstate '22023' then null; end;
  perform public.undo_transaction_classification(event,1);
  if not exists(select 1 from public.transactions where id=transaction and amount_minor=-1000 and version=2 and review_reasons=array['source_transfer','fee_semantics']) then raise exception 'Undo failed to restore review evidence'; end if;
  if (select classification_review_rows from public.imports where id=imported) <> 1 then raise exception 'Undo progress remains stale'; end if;
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin
    perform public.resolve_transaction_classification(transaction,2,'ordinary',true);
    raise exception 'Foreign classification accepted' using errcode='ZX001';
  exception when sqlstate 'P0002' then null; end;
end;
$$;
