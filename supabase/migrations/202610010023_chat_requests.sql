-- Persist execution claims and serialize cancellation with canonical writes/replies.
create table public.chat_requests (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message text not null,
  context jsonb not null default '{}'::jsonb,
  status text not null default 'running' check(status in ('running','completed','failed','canceled')),
  allowed_transaction_id uuid,
  allowed_category text,
  action_result jsonb,
  answer text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.chat_requests enable row level security;
create policy own_chat_requests on public.chat_requests for select to authenticated using(public.owns_workspace(workspace_id));
grant select on public.chat_requests to authenticated;
revoke insert,update,delete on public.chat_requests from public,authenticated;
create index chat_requests_workspace_created on public.chat_requests(workspace_id,created_at);

-- Keep retries of historical saved exchanges idempotent after introducing execution claims.
insert into public.chat_requests(id,workspace_id,conversation_id,message,context,status,answer,error,created_at)
select u.request_id,u.workspace_id,u.conversation_id,u.content,coalesce(u.context,'{}'::jsonb),
  case when a.id is null then 'failed' else 'completed' end,a.content,
  case when a.id is null then 'Historical request has no saved reply; start a new request' end,u.created_at
from public.messages u left join public.messages a on a.workspace_id=u.workspace_id
  and a.conversation_id=u.conversation_id and a.reply_to=u.request_id and a.role='assistant'
where u.role='user' and u.request_id is not null
on conflict(id) do nothing;

create function public.start_chat_request(p_request_id uuid,p_conversation_id uuid,p_message text,p_context jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  conversation public.conversations%rowtype;
  request_row public.chat_requests%rowtype;
  command text[];
  inserted boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_request_id is null or p_message is null or length(btrim(p_message)) not between 1 and 4000 or p_context is null
    or jsonb_typeof(p_context)<>'object' or length(p_context::text)>2000 then
    raise exception 'Invalid chat request' using errcode='22023';
  end if;
  select * into conversation from public.conversations where id=p_conversation_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Conversation unavailable' using errcode='P0002'; end if;
  command := regexp_match(btrim(p_message),'^set category of transaction ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) to "([^"\n]{1,100})"\.?$','i');
  insert into public.chat_requests(id,workspace_id,conversation_id,message,context,allowed_transaction_id,allowed_category)
    values(p_request_id,conversation.workspace_id,p_conversation_id,btrim(p_message),p_context,command[1]::uuid,nullif(btrim(command[2]),'')) on conflict(id) do nothing;
  inserted := found;
  select * into strict request_row from public.chat_requests where id=p_request_id for update;
  if request_row.workspace_id<>conversation.workspace_id or request_row.conversation_id<>p_conversation_id
    or request_row.message<>btrim(p_message) or request_row.context<>p_context then
    raise exception 'Request ID reused for a different request' using errcode='22023';
  end if;
  if inserted then
    insert into public.messages(workspace_id,conversation_id,role,content,context,request_id)
      values(conversation.workspace_id,p_conversation_id,'user',btrim(p_message),p_context,p_request_id);
  end if;
  return jsonb_build_object('started',inserted,'status',request_row.status,'answer',request_row.answer);
end;
$$;

create function public.chat_set_category(p_request_id uuid,p_transaction_id uuid,p_category text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  request_row public.chat_requests%rowtype;
  transaction_row public.transactions%rowtype;
  result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into request_row from public.chat_requests where id=p_request_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Chat request not found' using errcode='P0002'; end if;
  if request_row.status<>'running' then raise exception 'Chat request is no longer active' using errcode='57014'; end if;
  if p_transaction_id is distinct from request_row.allowed_transaction_id or request_row.allowed_category is null
    or p_category is distinct from request_row.allowed_category then
    raise exception 'Action must match the exact user-selected transaction and category' using errcode='22023';
  end if;
  if request_row.action_result is not null then return request_row.action_result; end if;
  select * into transaction_row from public.transactions where id=p_transaction_id and workspace_id=request_row.workspace_id for update;
  if not found then raise exception 'Transaction not found' using errcode='P0002'; end if;
  perform public.correct_transaction(p_transaction_id,transaction_row.version,p_category,coalesce(transaction_row.note,''));
  result := jsonb_build_object('status','updated','category',p_category,'transactionUrl','/money/transactions?transaction='||p_transaction_id::text);
  update public.chat_requests set action_result=result,updated_at=now() where id=p_request_id;
  return result;
end;
$$;

create function public.cancel_chat_request(p_request_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare request_row public.chat_requests%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into request_row from public.chat_requests where id=p_request_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Chat request not found' using errcode='P0002'; end if;
  if request_row.status='running' then
    update public.chat_requests set status='canceled',updated_at=now() where id=p_request_id;
    return 'canceled';
  end if;
  return request_row.status;
end;
$$;

create function public.finish_chat_request(p_request_id uuid,p_status text,p_content text)
returns text language plpgsql security definer set search_path='' as $$
declare request_row public.chat_requests%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_status is null or p_status not in ('completed','failed') or p_content is null or length(p_content)>20000 then
    raise exception 'Invalid chat completion' using errcode='22023';
  end if;
  select * into request_row from public.chat_requests where id=p_request_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Chat request not found' using errcode='P0002'; end if;
  if request_row.status<>'running' then return request_row.status; end if;
  if p_status='completed' then
    insert into public.messages(workspace_id,conversation_id,role,content,reply_to)
      values(request_row.workspace_id,request_row.conversation_id,'assistant',p_content,p_request_id);
  end if;
  update public.chat_requests set status=p_status,answer=case when p_status='completed' then p_content end,
    error=case when p_status='failed' then left(p_content,500) end,updated_at=now() where id=p_request_id;
  return p_status;
end;
$$;
revoke all on function public.start_chat_request(uuid,uuid,text,jsonb),public.chat_set_category(uuid,uuid,text),public.cancel_chat_request(uuid),public.finish_chat_request(uuid,text,text) from public;
grant execute on function public.start_chat_request(uuid,uuid,text,jsonb),public.chat_set_category(uuid,uuid,text),public.cancel_chat_request(uuid),public.finish_chat_request(uuid,text,text) to authenticated;
