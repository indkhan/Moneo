-- An undone duplicate re-import (e.g. a repeated bank sync) must not block undoing the original.
-- The runner rolls back the entire schema.
do $$
declare
  actor uuid:=gen_random_uuid(); workspace uuid; account uuid:=gen_random_uuid();
  original uuid:=gen_random_uuid(); duplicate uuid:=gen_random_uuid(); txn uuid:=gen_random_uuid();
  first_row uuid:=gen_random_uuid(); second_row uuid:=gen_random_uuid(); preview jsonb;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Bank','EUR');
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,new_rows,matched_rows) values
    (original,workspace,'sync-1.csv',workspace||'/1.csv',original::text,'completed',1,1,0),
    (duplicate,workspace,'sync-2.csv',workspace||'/2.csv',duplicate::text,'completed',1,0,1);
  insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code) values(txn,workspace,account,'2026-10-01','Coffee',-350,'EUR');
  insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row,status) values
    (first_row,workspace,original,2,'{}','new'),(second_row,workspace,duplicate,2,'{}','matched');
  insert into public.transaction_sources(transaction_id,source_transaction_id) values(txn,first_row),(txn,second_row);

  execute 'set local role authenticated';
  -- While the duplicate is live, the original stays blocked.
  preview:=public.preview_import_undo(original);
  if jsonb_array_length(preview->'blockers')=0 then raise exception 'Live duplicate did not block undo'; end if;
  perform public.undo_import(duplicate,0,0);
  preview:=public.preview_import_undo(original);
  if jsonb_array_length(preview->'blockers')>0 then raise exception 'Undone duplicate still blocks undo: %', preview->'blockers'; end if;
  perform public.undo_import(original,1,0);
  execute 'reset role';

  if exists(select 1 from public.transactions where id=txn) then raise exception 'Original transaction not removed'; end if;
  if (select count(*) from public.source_transactions where id in (first_row,second_row))<>2 then raise exception 'Source evidence lost'; end if;
end;
$$;
