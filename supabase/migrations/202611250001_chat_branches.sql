alter table public.conversations add column model text constraint conversations_model_check check (model is null or length(btrim(model)) between 1 and 200);
grant update (model) on public.conversations to authenticated;

alter table public.chat_requests add column parent_id uuid references public.chat_requests(id) on delete cascade;
create index chat_requests_parent on public.chat_requests(parent_id);
create index chat_requests_conversation_created on public.chat_requests(conversation_id, created_at);

alter table public.messages add column chat_request_id uuid;
create index messages_chat_request on public.messages(chat_request_id);

update public.chat_requests r set parent_id=(select p.id from public.chat_requests p where p.conversation_id=r.conversation_id
  and (p.created_at,p.id)<(r.created_at,r.id) order by p.created_at desc,p.id desc limit 1) where r.regenerates is null;
update public.chat_requests r set parent_id=o.parent_id from public.chat_requests o where r.regenerates=o.id;

update public.messages set chat_request_id=coalesce(request_id,reply_to) where request_id is not null or reply_to is not null;
update public.messages m set chat_request_id=(select r.id from public.chat_requests r where r.conversation_id=m.conversation_id
  and r.created_at<=m.created_at order by r.created_at desc,r.id desc limit 1) where m.chat_request_id is null;

create function public.set_message_chat_request() returns trigger language plpgsql security definer set search_path='' as $$
begin
  new.chat_request_id:=coalesce(new.chat_request_id,new.request_id,new.reply_to);
  return new;
end;
$$;
create trigger messages_chat_request before insert on public.messages for each row execute function public.set_message_chat_request();

create or replace function public.take_chat_steers(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare request_row public.chat_requests%rowtype; taken jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into request_row from public.chat_requests where id=p_request_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Request unavailable' using errcode='P0002'; end if;
  if request_row.status<>'running' then return '[]'::jsonb; end if;
  with claimed as (
    update public.chat_steers set consumed_at=now() where chat_request_id=p_request_id and consumed_at is null and closed_at is null returning id,content,created_at
  ), recorded as (
    insert into public.messages(workspace_id,conversation_id,role,content,context,created_at,chat_request_id)
      select request_row.workspace_id,request_row.conversation_id,'user',content,'{}'::jsonb,clock_timestamp(),p_request_id from (select content,created_at from claimed order by created_at) ordered
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'content',content) order by created_at),'[]'::jsonb) into taken from claimed;
  return taken;
end;
$$;

drop function public.start_chat_request(uuid,uuid,text,jsonb,uuid);
create function public.start_chat_request(p_request_id uuid,p_conversation_id uuid,p_message text,p_context jsonb,
  p_regenerates uuid default null,p_parent uuid default null,p_edits uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  conversation public.conversations%rowtype;
  request_row public.chat_requests%rowtype;
  original public.chat_requests%rowtype;
  parent uuid;
  command text[];
  inserted boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_request_id is null or p_message is null or length(btrim(p_message)) not between 1 and 4000 or p_context is null
    or jsonb_typeof(p_context)<>'object' or length(p_context::text)>2000 then
    raise exception 'Invalid chat request' using errcode='22023';
  end if;
  if num_nonnulls(p_regenerates,p_parent,p_edits)>1 then raise exception 'Choose one of regenerate, edit or continue' using errcode='22023'; end if;
  select * into conversation from public.conversations where id=p_conversation_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Conversation unavailable' using errcode='P0002'; end if;
  if coalesce(p_regenerates,p_edits) is not null then
    select * into original from public.chat_requests where id=coalesce(p_regenerates,p_edits) and conversation_id=p_conversation_id and workspace_id=conversation.workspace_id;
    if not found then raise exception 'Question not found' using errcode='P0002'; end if;
    if original.regenerates is not null or original.context->>'via' is not distinct from 'call' then
      raise exception 'Only a typed question can be regenerated or edited' using errcode='22023';
    end if;
    if p_regenerates is not null and (original.status<>'completed' or original.message<>btrim(p_message)) then
      raise exception 'Only a completed question can be regenerated' using errcode='22023';
    end if;
    parent:=original.parent_id;
  elsif p_parent is not null then
    if not exists(select 1 from public.chat_requests where id=p_parent and conversation_id=p_conversation_id and workspace_id=conversation.workspace_id) then
      raise exception 'Earlier message not found' using errcode='P0002';
    end if;
    parent:=p_parent;
  else
    select id into parent from public.chat_requests where conversation_id=p_conversation_id and id<>p_request_id order by created_at desc,id desc limit 1;
  end if;
  command := regexp_match(btrim(p_message),'^set category of transaction ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) to "([^"\n]{1,100})"\.?$','i');
  insert into public.chat_requests(id,workspace_id,conversation_id,message,context,allowed_transaction_id,allowed_category,regenerates,parent_id)
    values(p_request_id,conversation.workspace_id,p_conversation_id,btrim(p_message),p_context,command[1]::uuid,nullif(btrim(command[2]),''),p_regenerates,parent) on conflict(id) do nothing;
  inserted := found;
  select * into strict request_row from public.chat_requests where id=p_request_id for update;
  if request_row.workspace_id<>conversation.workspace_id or request_row.conversation_id<>p_conversation_id
    or request_row.message<>btrim(p_message) or request_row.context<>p_context or request_row.regenerates is distinct from p_regenerates
    or (coalesce(p_regenerates,p_edits,p_parent) is not null and request_row.parent_id is distinct from parent) then
    raise exception 'Request ID reused for a different request' using errcode='22023';
  end if;
  if inserted and p_regenerates is null then
    insert into public.messages(workspace_id,conversation_id,role,content,context,request_id)
      values(conversation.workspace_id,p_conversation_id,'user',btrim(p_message),p_context,p_request_id);
  end if;
  return jsonb_build_object('started',inserted,'status',request_row.status,'answer',request_row.answer,'parent',request_row.parent_id);
end;
$$;
revoke all on function public.start_chat_request(uuid,uuid,text,jsonb,uuid,uuid,uuid) from public,anon;
grant execute on function public.start_chat_request(uuid,uuid,text,jsonb,uuid,uuid,uuid) to authenticated;
