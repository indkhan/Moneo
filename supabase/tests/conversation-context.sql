do $$
declare
  actor uuid := gen_random_uuid(); workspace uuid; conversation uuid := gen_random_uuid(); qa_request uuid := gen_random_uuid(); canceled_id uuid := gen_random_uuid();
  snapshot jsonb := '{"memory":{"version":1,"kind":"dialogue","scopes":["planning"],"receiptIds":[]},"assembly":{"budgetBytes":16000},"messages":[{"role":"user","content":"Explain the second option"}],"submission":{}}';
  result text;
begin
  if has_function_privilege('authenticated','public.finish_contextual_chat_request(uuid,uuid,uuid,text,uuid[],text[],jsonb,jsonb)','execute')
    or has_function_privilege('anon','public.finish_contextual_chat_request(uuid,uuid,uuid,text,uuid[],text[],jsonb,jsonb)','execute')
    or not has_function_privilege('service_role','public.finish_contextual_chat_request(uuid,uuid,uuid,text,uuid[],text[],jsonb,jsonb)','execute') then
    raise exception 'Prompt snapshots must use trusted service publication';
  end if;
  insert into auth.users(id,email) values(actor,'qa-context-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  insert into public.conversations(id,workspace_id,title) values(conversation,workspace,'Synthetic context');
  perform public.start_chat_request(qa_request,conversation,'Explain the second option','{}');
  perform set_config('request.jwt.claim.role','service_role',true);
  begin
    perform public.finish_contextual_chat_request(qa_request,gen_random_uuid(),workspace,'Option two: explore forecast assumptions.',array[]::uuid[],array['planning'],null,snapshot);
    raise exception 'Foreign actor must not publish context';
  exception when sqlstate 'P0002' then null; end;
  insert into public.workspace_settings(workspace_id,ai_data_scopes) values(workspace,array['accounts','transactions'])
    on conflict(workspace_id) do update set ai_data_scopes=excluded.ai_data_scopes;
  begin
    perform public.finish_contextual_chat_request(qa_request,actor,workspace,'Option two: explore forecast assumptions.',array[]::uuid[],array['planning'],null,snapshot);
    raise exception 'Revoked dialogue scope must prevent publication';
  exception when sqlstate '42501' then null; end;
  if exists(select 1 from public.messages where reply_to=qa_request) then raise exception 'Rejected publication changed history'; end if;
  update public.workspace_settings set ai_data_scopes=array['accounts','transactions','planning'] where workspace_id=workspace;
  begin
    perform public.finish_contextual_chat_request(qa_request,actor,workspace,'Option two: explore forecast assumptions.',array[]::uuid[],array['planning'],null,jsonb_set(snapshot,'{memory,kind}','"evidence"'));
    raise exception 'Dialogue and receipt provenance mismatch must fail';
  exception when sqlstate '22023' then null; end;
  result := public.finish_contextual_chat_request(qa_request,actor,workspace,'Option two: explore forecast assumptions.',array[]::uuid[],array['planning'],null,snapshot);
  if result<>'completed' or (select context from public.messages where reply_to=qa_request) is distinct from snapshot then raise exception 'Exact permitted dialogue snapshot was not saved'; end if;
  perform public.finish_contextual_chat_request(qa_request,actor,workspace,'Changed response',array[]::uuid[],array['planning'],null,jsonb_set(snapshot,'{submission}','{"path":"/changed"}'));
  if (select context from public.messages where reply_to=qa_request) is distinct from snapshot then raise exception 'Retry rewrote the original prompt snapshot'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform public.start_chat_request(canceled_id,conversation,'Explain the second option','{}');
  perform public.cancel_chat_request(canceled_id);
  perform set_config('request.jwt.claim.role','service_role',true);
  result := public.finish_contextual_chat_request(canceled_id,actor,workspace,'Late reply',array[]::uuid[],array['planning'],null,snapshot);
  if result<>'canceled' or exists(select 1 from public.messages where reply_to=canceled_id) then raise exception 'Canceled request acquired a prompt snapshot'; end if;
end;
$$;
