-- Steer messages are injected into a running chat request at its next model step.
create table public.chat_steers (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  chat_request_id uuid not null references public.chat_requests(id) on delete cascade,
  content text not null check (length(btrim(content)) between 1 and 4000),
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);
create index chat_steers_pending on public.chat_steers(chat_request_id, created_at) where consumed_at is null;
alter table public.chat_steers enable row level security;
create policy own_chat_steers on public.chat_steers for select to authenticated using(public.owns_workspace(workspace_id));
grant select on public.chat_steers to authenticated;
revoke insert,update,delete on public.chat_steers from public,authenticated;

-- Accepts a steer only while the owned request is still running.
create function public.steer_chat_request(p_steer_id uuid,p_request_id uuid,p_message text)
returns boolean language plpgsql security definer set search_path='' as $$
declare request_row public.chat_requests%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_steer_id is null or p_message is null or length(btrim(p_message)) not between 1 and 4000 then
    raise exception 'Invalid steer' using errcode='22023';
  end if;
  select * into request_row from public.chat_requests where id=p_request_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Request unavailable' using errcode='P0002'; end if;
  if request_row.status<>'running' then return false; end if;
  insert into public.chat_steers(id,workspace_id,chat_request_id,content) values(p_steer_id,request_row.workspace_id,p_request_id,btrim(p_message))
    on conflict(id) do nothing;
  return true;
end;
$$;

-- Claims pending steers for the next model step and records them in the transcript.
create function public.take_chat_steers(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare request_row public.chat_requests%rowtype; taken jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into request_row from public.chat_requests where id=p_request_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Request unavailable' using errcode='P0002'; end if;
  if request_row.status<>'running' then return '[]'::jsonb; end if;
  with claimed as (
    update public.chat_steers set consumed_at=now() where chat_request_id=p_request_id and consumed_at is null returning id,content,created_at
  ), recorded as (
    insert into public.messages(workspace_id,conversation_id,role,content,context,request_id)
      select request_row.workspace_id,request_row.conversation_id,'user',content,'{}'::jsonb,id from claimed
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'content',content) order by created_at),'[]'::jsonb) into taken from claimed;
  return taken;
end;
$$;
revoke all on function public.steer_chat_request(uuid,uuid,text),public.take_chat_steers(uuid) from public;
grant execute on function public.steer_chat_request(uuid,uuid,text),public.take_chat_steers(uuid) to authenticated;
