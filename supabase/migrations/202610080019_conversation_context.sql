-- Successful context snapshots share the existing trusted publication transaction.
-- No client can tag an assistant answer as safe dialogue or rewrite its snapshot.
create function public.finish_contextual_chat_request(
  p_request_id uuid,p_actor_id uuid,p_workspace_id uuid,p_content text,
  p_receipt_ids uuid[],p_scopes text[],p_usage jsonb,p_prompt_context jsonb
) returns text language plpgsql security definer set search_path='' as $$
declare request_row public.chat_requests%rowtype; result text;
begin
  if auth.role() is distinct from 'service_role' or p_actor_id is null then
    raise exception 'Trusted context publication actor required' using errcode='42501';
  end if;
  if p_prompt_context is null or jsonb_typeof(p_prompt_context) is distinct from 'object'
    or octet_length(p_prompt_context::text)>131072
    or p_prompt_context-array['memory','assembly','messages','submission']<>'{}'::jsonb
    or p_prompt_context#>'{memory,version}' is distinct from '1'::jsonb
    or p_prompt_context#>'{memory,scopes}' is distinct from to_jsonb(p_scopes)
    or p_prompt_context#>'{memory,receiptIds}' is distinct from to_jsonb(p_receipt_ids)
    or p_prompt_context#>>'{memory,kind}' is distinct from (case when cardinality(p_receipt_ids)=0 then 'dialogue' else 'evidence' end)
    or jsonb_typeof(p_prompt_context->'assembly') is distinct from 'object'
    or p_prompt_context#>'{assembly,budgetBytes}' is distinct from '16000'::jsonb
    or jsonb_typeof(p_prompt_context->'messages') is distinct from 'array'
    or jsonb_typeof(p_prompt_context->'submission') is distinct from 'object' then
    raise exception 'Invalid trusted prompt snapshot' using errcode='22023';
  end if;
  if jsonb_array_length(p_prompt_context->'messages') not between 1 and 210
    or octet_length((p_prompt_context->'messages')::text)>32000
    or exists(select 1 from jsonb_array_elements(p_prompt_context->'messages') message
      where jsonb_typeof(message) is distinct from 'object' or message-array['role','content']<>'{}'::jsonb
        or message->>'role' is null or message->>'role' not in ('user','assistant') or jsonb_typeof(message->'content') is distinct from 'string') then
    raise exception 'Invalid prompt messages or budget' using errcode='22023';
  end if;
  -- Keep workspace-before-request lock order used by verified publication.
  perform 1 from public.workspaces where id=p_workspace_id and owner_id=p_actor_id for update;
  if not found then raise exception 'Chat workspace not found' using errcode='P0002'; end if;
  select * into request_row from public.chat_requests where id=p_request_id and workspace_id=p_workspace_id for update;
  if not found then raise exception 'Chat request not found' using errcode='P0002'; end if;
  if not exists(select 1 from jsonb_array_elements(p_prompt_context->'messages') message
    where message->>'role'='user' and message->>'content'=request_row.message) then
    raise exception 'Prompt snapshot omits the current question' using errcode='22023';
  end if;
  result := public.finish_verified_chat_request(p_request_id,p_actor_id,p_workspace_id,p_content,p_receipt_ids,p_scopes,p_usage);
  if result='completed' and request_row.status='running' then
    update public.messages set context=p_prompt_context
      where workspace_id=p_workspace_id and conversation_id=request_row.conversation_id and reply_to=p_request_id and role='assistant';
  end if;
  return result;
end;
$$;
revoke all on function public.finish_contextual_chat_request(uuid,uuid,uuid,text,uuid[],text[],jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.finish_contextual_chat_request(uuid,uuid,uuid,text,uuid[],text[],jsonb,jsonb) to service_role;
