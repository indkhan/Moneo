-- Candidate-only organization regression. Run in an owned rollback schema.
do $$
declare
  actor uuid := gen_random_uuid(); foreign_actor uuid := gen_random_uuid(); workspace uuid; foreign_workspace uuid;
  account uuid := gen_random_uuid(); category uuid := gen_random_uuid(); merchant uuid := gen_random_uuid(); other_merchant uuid := gen_random_uuid(); foreign_merchant uuid := gen_random_uuid();
  first_id uuid; second_id uuid; source_id uuid := gen_random_uuid(); import_id uuid := gen_random_uuid();
  rows jsonb; result jsonb; batch uuid; request uuid := gen_random_uuid(); canonical jsonb; originals jsonb; event uuid;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(foreign_actor,'qa-'||foreign_actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  select id into strict foreign_workspace from public.workspaces where owner_id=foreign_actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Organization fixture','EUR');
  insert into public.categories(id,workspace_id,name) values(category,workspace,'Owned category');
  insert into public.merchants(id,workspace_id,name,normalized_name) values
    (merchant,workspace,'Owned merchant','owned merchant'),(other_merchant,workspace,'Previous merchant','previous merchant'),
    (foreign_merchant,foreign_workspace,'Foreign merchant','foreign merchant');
  result := public.create_manual_transaction(account,'2026-09-03','Noisy purchase REF:781','-9007199254740993','posted',null,'Original source note',gen_random_uuid());
  first_id := (result->>'id')::uuid;
  result := public.create_manual_transaction(account,'2026-09-04','Noisy purchase REF:782','-100','posted',null,'',gen_random_uuid());
  second_id := (result->>'id')::uuid;
  update public.transactions set merchant_id=other_merchant,review_reasons=array['source_type'] where id=second_id;
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash) values(import_id,workspace,'owned-organization.csv','owned-fixture','owned-'||import_id);
  insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row) values(source_id,workspace,import_id,1,'{"description":"Noisy purchase REF:782","amount":"-1.00"}');
  insert into public.transaction_sources(transaction_id,source_transaction_id) values(second_id,source_id);
  select jsonb_agg(to_jsonb(t)-array['category_id','merchant_id','version'] order by id) into canonical from public.transactions t where workspace_id=workspace;
  select jsonb_build_object('imports',(select jsonb_agg(to_jsonb(i)) from public.imports i where workspace_id=workspace),
    'sources',(select jsonb_agg(to_jsonb(s)) from public.source_transactions s where workspace_id=workspace),
    'links',(select jsonb_agg(to_jsonb(l)) from public.transaction_sources l where transaction_id in(first_id,second_id)),
    'manual',(select jsonb_agg(to_jsonb(m) order by id) from public.manual_transaction_entries m where workspace_id=workspace)) into originals;
  rows := jsonb_build_array(jsonb_build_object('id',first_id,'version',0),jsonb_build_object('id',second_id,'version',0));

  -- Baseline rejects merchant metadata. The candidate must apply both fields atomically.
  result := public.bulk_edit_transactions(rows,jsonb_build_object('merchant_id',merchant,'category_id',category),request);
  batch := (result->>'batchId')::uuid;
  if (select count(*) from public.transactions where workspace_id=workspace and merchant_id=merchant and category_id=category and version=1)<>2 then raise exception 'Organization batch did not apply exact metadata'; end if;
  if public.bulk_edit_transactions(rows,jsonb_build_object('merchant_id',merchant,'category_id',category),request)<>result then raise exception 'Organization retry duplicated effects'; end if;
  if (select count(*) from public.correction_events where workspace_id=workspace and after->>'batch_id'=batch::text and before ? 'merchant_id' and after->>'merchant_id'=merchant::text)<>2 then raise exception 'Merchant before/after history missing'; end if;
  if (select jsonb_agg(to_jsonb(t)-array['category_id','merchant_id','version'] order by id) from public.transactions t where workspace_id=workspace)<>canonical then raise exception 'Organization changed financial truth'; end if;

  begin
    perform public.bulk_edit_transactions(jsonb_build_array(jsonb_build_object('id',first_id,'version',1)),jsonb_build_object('merchant_id',foreign_merchant),gen_random_uuid());
    raise exception 'Foreign merchant accepted';
  exception when sqlstate 'P0002' then null; end;
  begin
    perform public.bulk_edit_transactions(jsonb_build_array(jsonb_build_object('id',first_id,'version',1)),jsonb_build_object('merchant_id',merchant,'amount_minor','0'),gen_random_uuid());
    raise exception 'Organization amount mutation accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.bulk_edit_transactions(jsonb_build_array(jsonb_build_object('id',first_id,'version',1),jsonb_build_object('id',second_id,'version',0)),jsonb_build_object('merchant_id',null),gen_random_uuid());
    raise exception 'Stale organization preview accepted';
  exception when sqlstate '40001' then null; end;
  if (select count(*) from public.transaction_batches where workspace_id=workspace)<>1 or exists(select 1 from public.transactions where workspace_id=workspace and merchant_id is distinct from merchant) then raise exception 'Rejected organization batch partially wrote'; end if;

  begin
    perform public.undo_transaction_batch(batch,jsonb_build_array(jsonb_build_object('id',first_id,'version',1),jsonb_build_object('id',second_id,'version',0)));
    raise exception 'Partial stale organization Undo accepted';
  exception when sqlstate '40001' then null; end;
  if exists(select 1 from public.transactions where workspace_id=workspace and version<>1) or exists(select 1 from public.correction_events where workspace_id=workspace and undone) then raise exception 'Failed Undo partially restored organization'; end if;
  perform public.undo_transaction_batch(batch,jsonb_build_array(jsonb_build_object('id',first_id,'version',1),jsonb_build_object('id',second_id,'version',1)));
  if not exists(select 1 from public.transactions where id=first_id and merchant_id is null and category_id is null and version=2)
    or not exists(select 1 from public.transactions where id=second_id and merchant_id=other_merchant and category_id is null and version=2)
    then raise exception 'Atomic organization Undo lost original metadata'; end if;
  if (select count(*) from public.correction_events where workspace_id=workspace and undone)<>2 then raise exception 'Organization Undo history incomplete'; end if;

  -- Applied old receipts omit merchant fields. Undo must retain their prior semantics.
  result := public.bulk_edit_transactions(jsonb_build_array(jsonb_build_object('id',first_id,'version',2)),jsonb_build_object('category_id',category),gen_random_uuid());
  select id into strict event from public.correction_events where transaction_id=first_id and not undone;
  update public.correction_events set before=before-'merchant_id',after=after-'merchant_id' where id=event;
  update public.transactions set merchant_id=other_merchant where id=first_id;
  perform public.undo_transaction_metadata(event,3);
  if not exists(select 1 from public.transactions where id=first_id and merchant_id=other_merchant and category_id is null and version=4) then raise exception 'Legacy Undo erased unrecorded merchant'; end if;

  if jsonb_build_object('imports',(select jsonb_agg(to_jsonb(i)) from public.imports i where workspace_id=workspace),
    'sources',(select jsonb_agg(to_jsonb(s)) from public.source_transactions s where workspace_id=workspace),
    'links',(select jsonb_agg(to_jsonb(l)) from public.transaction_sources l where transaction_id in(first_id,second_id)),
    'manual',(select jsonb_agg(to_jsonb(m) order by id) from public.manual_transaction_entries m where workspace_id=workspace))<>originals then raise exception 'Organization changed immutable source evidence'; end if;
  perform set_config('request.jwt.claim.sub',foreign_actor::text,true);
  begin
    perform public.bulk_edit_transactions(jsonb_build_array(jsonb_build_object('id',second_id,'version',2)),jsonb_build_object('merchant_id',foreign_merchant),gen_random_uuid());
    raise exception 'Foreign transaction organization accepted';
  exception when sqlstate 'P0002' then null; end;
end;
$$;
