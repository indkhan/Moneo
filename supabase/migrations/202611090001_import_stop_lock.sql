-- Stop could deadlock with a running import: Stop took a full lock on the workspace and then waited for the import row,
-- while the worker held the import row and needed the workspace's key lock to insert rows. This lock still lets only one
-- Stop or Resume through at a time, and doesn't block those inserts. Nothing else in the function changes.
create or replace function public.control_import(p_import_id uuid,p_action text,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare imported public.imports%rowtype; receipt public.import_control_events%rowtype; result jsonb; started boolean:=false; workspace uuid; previous_status text;
begin
  if p_import_id is null or p_request_id is null or p_action is null or p_action not in ('cancel','resume') then raise exception 'Invalid import control' using errcode='22023'; end if;
  select workspace_id into workspace from public.imports where id=p_import_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Import not found' using errcode='P0002'; end if;
  perform id from public.workspaces where id=workspace for no key update;
  select * into imported from public.imports where id=p_import_id and workspace_id=workspace for update;
  previous_status:=imported.status;
  select * into receipt from public.import_control_events where workspace_id=workspace and request_id=p_request_id;
  if found then
    if receipt.import_id is distinct from p_import_id or receipt.action is distinct from p_action then raise exception 'Import control request changed' using errcode='22023'; end if;
    return receipt.result||jsonb_build_object('started',false,'status',imported.status,'runVersion',imported.run_version);
  end if;
  if p_action='cancel' and imported.status in ('pending','queued','running') then
    update public.imports set status='canceled',error=null,run_version=run_version+1 where id=imported.id returning * into imported;
    perform public.recount_import_progress(imported.id);
    started:=true;
  elsif p_action='resume' and imported.status in ('failed','canceled') then
    if imported.total_rows<1 or jsonb_typeof(imported.mapping) is distinct from 'object' or imported.mapping->>'dateColumn' is null or imported.mapping->>'descriptionColumn' is null
      or left(imported.storage_path,length(workspace::text)+1) is distinct from workspace::text||'/'
      or exists(select 1 from public.import_control_events ce where ce.import_id=imported.id and ce.action='cancel' and ce.result->>'previousStatus'='pending') then raise exception 'Review and confirm the file mapping before starting this import' using errcode='22023'; end if;
    update public.imports set status='queued',error=null,run_version=run_version+1 where id=imported.id returning * into imported;
    started:=true;
  end if;
  result:=jsonb_build_object('importId',imported.id,'status',imported.status,'runVersion',imported.run_version,'totalRows',imported.total_rows,'started',started,'previousStatus',previous_status);
  insert into public.import_control_events(workspace_id,import_id,request_id,action,result,actor_id) values(workspace,imported.id,p_request_id,p_action,result,auth.uid());
  return result;
end;
$$;
