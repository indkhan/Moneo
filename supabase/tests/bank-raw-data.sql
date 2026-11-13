-- The bank's full transaction beside the statement CSV: owner-only read, service-role writes, one row per
-- (import, row), and gone when its import is undone. Synthetic data only; the runner rolls this back.
do $$
declare
  actor uuid:=gen_random_uuid(); stranger uuid:=gen_random_uuid(); workspace uuid; other_workspace uuid; account uuid:=gen_random_uuid();
  kept uuid:=gen_random_uuid(); undone uuid:=gen_random_uuid(); foreign_import uuid:=gen_random_uuid();
  txn uuid:=gen_random_uuid(); source_row uuid:=gen_random_uuid();
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid'),(stranger,'qa-'||stranger||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  select id into strict other_workspace from public.workspaces where owner_id=stranger;
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Bank','EUR');
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,new_rows,matched_rows) values
    (kept,workspace,'a.csv',workspace||'/a.csv',kept::text,'completed',1,1,0),
    (undone,workspace,'b.csv',workspace||'/b.csv',undone::text,'completed',1,1,0),
    (foreign_import,other_workspace,'c.csv',other_workspace||'/c.csv',foreign_import::text,'completed',1,1,0);
  insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code) values(txn,workspace,account,'2026-10-01','Coffee',-350,'EUR');
  insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row,status) values(source_row,workspace,undone,2,'{}','new');
  insert into public.transaction_sources(transaction_id,source_transaction_id) values(txn,source_row);
  insert into public.bank_transaction_raw(import_id,row_number,workspace_id,bank_id,raw,payment_type,mcc,counterparty_ids,own_account) values
    (kept,2,workspace,'k1','{"entry_reference":"k1"}','card','5411','[{"identification":"x"}]',false),
    (undone,2,workspace,'u1','{"entry_reference":"u1"}','transfer',null,'[]',true),
    (foreign_import,2,other_workspace,'f1','{}','unknown',null,'[]',false);

  -- One row per (import, row): a repeated sync is a no-op, a second value for the same row is refused.
  insert into public.bank_transaction_raw(import_id,row_number,workspace_id,bank_id) values(kept,2,workspace,'again') on conflict(import_id,row_number) do nothing;
  if (select bank_id from public.bank_transaction_raw where import_id=kept and row_number=2)<>'k1' then raise exception 'A repeated write replaced the stored row'; end if;
  begin
    insert into public.bank_transaction_raw(import_id,row_number,workspace_id,payment_type) values(kept,3,workspace,'wire');
    raise exception 'An unknown payment type was accepted' using errcode='ZX001';
  exception when check_violation then null; end;
  begin
    insert into public.bank_transaction_raw(import_id,row_number,workspace_id,raw) values(kept,4,workspace,to_jsonb(repeat('x',70000)));
    raise exception 'A non-object or oversized raw row was accepted' using errcode='ZX001';
  exception when check_violation then null; end;

  -- The owner reads their own rows only and cannot write.
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  if (select count(*) from public.bank_transaction_raw)<>2 or exists(select 1 from public.bank_transaction_raw where workspace_id=other_workspace) then raise exception 'Owner does not see exactly their own raw rows'; end if;
  begin
    insert into public.bank_transaction_raw(import_id,row_number,workspace_id) values(kept,5,workspace);
    raise exception 'Owner wrote a raw row' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.bank_transaction_raw where import_id=kept;
    raise exception 'Owner deleted a raw row' using errcode='ZX001';
  exception when insufficient_privilege then null; end;

  -- Undoing an import removes its raw rows and leaves the others' alone.
  perform public.undo_import(undone,1,0);
  execute 'reset role';
  if exists(select 1 from public.bank_transaction_raw where import_id=undone) then raise exception 'Undo left raw rows behind'; end if;
  if (select count(*) from public.bank_transaction_raw where import_id in (kept,foreign_import))<>2 then raise exception 'Undo removed another import''s raw rows'; end if;
  if (select status from public.imports where id=undone)<>'undone' or not exists(select 1 from public.source_transactions where id=source_row) then raise exception 'Undo lost the import history'; end if;

  -- The stranger sees none of the owner's rows.
  perform set_config('request.jwt.claim.sub',stranger::text,true);
  execute 'set local role authenticated';
  if (select count(*) from public.bank_transaction_raw where workspace_id=workspace)<>0 then raise exception 'A stranger read raw rows'; end if;
  execute 'reset role';
end;
$$;
