-- Steer messages are injected into a running chat request at its next model step.
create table public.chat_steers (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  chat_request_id uuid not null references public.chat_requests(id) on delete cascade,
  content text not null check (length(btrim(content)) between 1 and 4000),
  created_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz,
  -- Set when the request ends with the steer untaken; a closed steer is never injected.
  closed_at timestamptz
);
create index chat_steers_pending on public.chat_steers(chat_request_id, created_at) where consumed_at is null and closed_at is null;
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
  -- The row lock orders this against the request finishing, which closes its pending steers.
  select * into request_row from public.chat_requests where id=p_request_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Request unavailable' using errcode='P0002'; end if;
  if request_row.status<>'running' then return false; end if;
  insert into public.chat_steers(id,workspace_id,chat_request_id,content) values(p_steer_id,request_row.workspace_id,p_request_id,btrim(p_message))
    on conflict(id) do nothing;
  -- A retried id counts only when it already belongs to this request.
  return exists(select 1 from public.chat_steers where id=p_steer_id and chat_request_id=p_request_id and closed_at is null);
end;
$$;

-- Claims pending steers for the next model step and records them in the transcript.
create function public.take_chat_steers(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare request_row public.chat_requests%rowtype; taken jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into request_row from public.chat_requests where id=p_request_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Request unavailable' using errcode='P0002'; end if;
  if request_row.status<>'running' then return '[]'::jsonb; end if;
  -- The conditional update claims each steer once; each transcript row gets its own ordered time.
  with claimed as (
    update public.chat_steers set consumed_at=now() where chat_request_id=p_request_id and consumed_at is null and closed_at is null returning id,content,created_at
  ), recorded as (
    insert into public.messages(workspace_id,conversation_id,role,content,context,created_at)
      select request_row.workspace_id,request_row.conversation_id,'user',content,'{}'::jsonb,clock_timestamp() from (select content,created_at from claimed order by created_at) ordered
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'content',content) order by created_at),'[]'::jsonb) into taken from claimed;
  return taken;
end;
$$;

-- A request that stops running closes its untaken steers, so they can never be injected later.
create function public.close_chat_steers() returns trigger language plpgsql security definer set search_path='' as $$
begin
  update public.chat_steers set closed_at=now() where chat_request_id=new.id and consumed_at is null and closed_at is null;
  return new;
end;
$$;
create trigger chat_requests_close_steers after update of status on public.chat_requests
  for each row when (old.status='running' and new.status<>'running') execute function public.close_chat_steers();

revoke all on function public.steer_chat_request(uuid,uuid,text),public.take_chat_steers(uuid),public.close_chat_steers() from public;
grant execute on function public.steer_chat_request(uuid,uuid,text),public.take_chat_steers(uuid) to authenticated;
