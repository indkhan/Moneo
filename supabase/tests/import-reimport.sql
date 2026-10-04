-- Run inside a transaction and roll back; all evidence below is synthetic.
do $$
declare actor uuid := gen_random_uuid(); workspace uuid; old_import uuid := gen_random_uuid(); new_import uuid := gen_random_uuid(); file_hash text := gen_random_uuid()::text; old_source uuid := gen_random_uuid();
begin
  insert into auth.users(id,email) values(actor,'qa-reimport-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,undone_at,undone_by)
    values(old_import,workspace,'synthetic.csv',workspace||'/synthetic.csv',file_hash,'undone',now(),actor);
  insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row,status)
    values(old_source,workspace,old_import,2,'{"Description":"Synthetic preserved source","Amount":"-2.00"}','undone');
  insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status)
    values(new_import,workspace,'synthetic.csv',workspace||'/synthetic.csv',file_hash,'queued');
  begin
    insert into public.imports(workspace_id,filename,storage_path,file_hash,status)
      values(workspace,'synthetic.csv',workspace||'/synthetic.csv',file_hash,'queued');
    raise exception 'Two active imports accepted for identical bytes';
  exception when unique_violation then null; end;
  if not exists(select 1 from public.imports where id=old_import and status='undone' and undone_at is not null and undone_by=actor)
     or not exists(select 1 from public.source_transactions where id=old_source and import_id=old_import and status='undone' and original_row->>'Amount'='-2.00') then
    raise exception 'Reimport changed original undo evidence';
  end if;
  update public.imports set status='undone' where id=new_import;
  insert into public.imports(workspace_id,filename,storage_path,file_hash,status)
    values(workspace,'synthetic.csv',workspace||'/synthetic.csv',file_hash,'queued');
end $$;
