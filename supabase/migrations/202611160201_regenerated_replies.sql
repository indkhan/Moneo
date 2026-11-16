alter table public.chat_requests add column regenerates uuid references public.chat_requests(id) on delete cascade;
alter table public.messages add column answer_of uuid;
update public.messages set answer_of=reply_to where role='assistant' and reply_to is not null;

create function public.set_message_answer_of() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.role='assistant' and new.reply_to is not null and new.answer_of is null then
    select coalesce(regenerates,new.reply_to) into new.answer_of from public.chat_requests where id=new.reply_to;
    new.answer_of:=coalesce(new.answer_of,new.reply_to);
  end if;
  return new;
end;
$$;
create trigger messages_answer_of before insert on public.messages for each row execute function public.set_message_answer_of();

drop function public.start_chat_request(uuid,uuid,text,jsonb);
create function public.start_chat_request(p_request_id uuid,p_conversation_id uuid,p_message text,p_context jsonb,p_regenerates uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  conversation public.conversations%rowtype;
  request_row public.chat_requests%rowtype;
  original public.chat_requests%rowtype;
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
  if p_regenerates is not null then
    select * into original from public.chat_requests where id=p_regenerates and conversation_id=p_conversation_id and workspace_id=conversation.workspace_id;
    if not found then raise exception 'Question to regenerate not found' using errcode='P0002'; end if;
    if original.regenerates is not null or original.status<>'completed' or original.message<>btrim(p_message)
      or original.context->>'via' is not distinct from 'call' then
      raise exception 'Only a completed question can be regenerated' using errcode='22023';
    end if;
    if exists(select 1 from public.messages later where later.conversation_id=p_conversation_id and later.role='user' and later.request_id is not null
      and later.created_at>(select created_at from public.messages where conversation_id=p_conversation_id and request_id=p_regenerates and role='user')) then
      raise exception 'Only the latest reply can be regenerated' using errcode='22023';
    end if;
  end if;
  command := regexp_match(btrim(p_message),'^set category of transaction ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) to "([^"\n]{1,100})"\.?$','i');
  insert into public.chat_requests(id,workspace_id,conversation_id,message,context,allowed_transaction_id,allowed_category,regenerates)
    values(p_request_id,conversation.workspace_id,p_conversation_id,btrim(p_message),p_context,command[1]::uuid,nullif(btrim(command[2]),''),p_regenerates) on conflict(id) do nothing;
  inserted := found;
  select * into strict request_row from public.chat_requests where id=p_request_id for update;
  if request_row.workspace_id<>conversation.workspace_id or request_row.conversation_id<>p_conversation_id
    or request_row.message<>btrim(p_message) or request_row.context<>p_context or request_row.regenerates is distinct from p_regenerates then
    raise exception 'Request ID reused for a different request' using errcode='22023';
  end if;
  if inserted and p_regenerates is null then
    insert into public.messages(workspace_id,conversation_id,role,content,context,request_id)
      values(conversation.workspace_id,p_conversation_id,'user',btrim(p_message),p_context,p_request_id);
  end if;
  return jsonb_build_object('started',inserted,'status',request_row.status,'answer',request_row.answer);
end;
$$;
revoke all on function public.start_chat_request(uuid,uuid,text,jsonb,uuid) from public,anon;
grant execute on function public.start_chat_request(uuid,uuid,text,jsonb,uuid) to authenticated;
