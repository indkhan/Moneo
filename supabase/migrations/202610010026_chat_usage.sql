-- Store only reported counts, never infer provider billing from catalogue prices.
alter table public.chat_requests add column usage jsonb;
drop function public.finish_chat_request(uuid,text,text);
create function public.finish_chat_request(p_request_id uuid,p_status text,p_content text,p_usage jsonb default null)
returns text language plpgsql security definer set search_path='' as $$
declare request_row public.chat_requests%rowtype; token_key text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_status is null or p_status not in ('completed','failed') or p_content is null or length(p_content)>20000 then
    raise exception 'Invalid chat completion' using errcode='22023';
  end if;
  if p_usage is not null then
    if jsonb_typeof(p_usage)<>'object' or p_usage - array['model_id','input_tokens','output_tokens','total_tokens'] <> '{}'::jsonb
      or jsonb_typeof(p_usage->'model_id') is distinct from 'string' or length(p_usage->>'model_id') not between 1 and 200 then
      raise exception 'Invalid provider usage' using errcode='22023';
    end if;
    foreach token_key in array array['input_tokens','output_tokens','total_tokens'] loop
      if p_usage ? token_key and p_usage->token_key <> 'null'::jsonb and
        (jsonb_typeof(p_usage->token_key)<>'number' or p_usage->>token_key !~ '^[0-9]+$' or (p_usage->>token_key)::numeric>9007199254740991) then
        raise exception 'Invalid token count' using errcode='22023';
      end if;
    end loop;
  end if;
  select * into request_row from public.chat_requests where id=p_request_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Chat request not found' using errcode='P0002'; end if;
  if request_row.status<>'running' then return request_row.status; end if;
  if p_status='completed' then
    insert into public.messages(workspace_id,conversation_id,role,content,reply_to)
      values(request_row.workspace_id,request_row.conversation_id,'assistant',p_content,p_request_id);
  end if;
  update public.chat_requests set status=p_status,answer=case when p_status='completed' then p_content end,
    error=case when p_status='failed' then left(p_content,500) end,usage=p_usage,updated_at=now() where id=p_request_id;
  return p_status;
end;
$$;
revoke all on function public.finish_chat_request(uuid,text,text,jsonb) from public;
grant execute on function public.finish_chat_request(uuid,text,text,jsonb) to authenticated;
