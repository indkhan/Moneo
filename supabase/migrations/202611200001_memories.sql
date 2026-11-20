create table public.memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('pledge','plan','fact','explanation','preference')),
  statement text not null check (length(btrim(statement)) between 1 and 500),
  quote text check (length(btrim(quote)) between 1 and 500),
  status text not null default 'active' check (status in ('suggested','active','replaced','ended')),
  valid_from date,
  valid_until date,
  ended_on date,
  replaces uuid references public.memories(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  request_id uuid,
  saved_by text not null check (saved_by in ('ai','owner')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  search tsvector generated always as (to_tsvector('simple', statement || ' ' || coalesce(quote, ''))) stored,
  check (valid_until is null or valid_from is null or valid_until >= valid_from),
  check ((status in ('replaced','ended')) = (closed_at is not null)),
  check (saved_by = 'owner' or (quote is not null and conversation_id is not null))
);
create index memories_workspace_status on public.memories(workspace_id, status, created_at desc);
create index memories_search on public.memories using gin(search);
create index memories_conversation on public.memories(conversation_id) where conversation_id is not null;
create unique index memories_replaced_once on public.memories(replaces) where replaces is not null and status <> 'suggested';

alter table public.memories enable row level security;
create policy own_memories on public.memories for select to authenticated using (workspace_id in (select public.owned_workspace_ids()));
grant select on public.memories to authenticated;
grant all on public.memories to service_role;

create function public.memory_text(value text) returns text language sql immutable set search_path='' as $$
  select btrim(regexp_replace(lower(translate(coalesce(value, ''), '’‘“”', '''''""')), '\s+', ' ', 'g'))
$$;

create function public.owner_said(p_workspace_id uuid, p_conversation_id uuid, p_quote text) returns boolean language sql stable security definer set search_path='' as $$
  select length(public.memory_text(p_quote)) >= 3 and (
    exists (select 1 from public.messages m where m.workspace_id=p_workspace_id and m.conversation_id=p_conversation_id and m.role='user'
      and position(public.memory_text(p_quote) in public.memory_text(m.content)) > 0)
    or exists (select 1 from public.chat_steers s join public.chat_requests r on r.id=s.chat_request_id
      where s.workspace_id=p_workspace_id and r.conversation_id=p_conversation_id
        and position(public.memory_text(p_quote) in public.memory_text(s.content)) > 0))
$$;
revoke all on function public.owner_said(uuid,uuid,text) from public, anon, authenticated;

create function public.owned_conversation_workspace(p_conversation_id uuid) returns uuid language plpgsql stable security definer set search_path='' as $$
declare ws uuid;
begin
  select c.workspace_id into ws from public.conversations c where c.id=p_conversation_id and c.deleted_at is null and public.owns_workspace(c.workspace_id);
  if ws is null then raise exception 'Conversation unavailable' using errcode='42501'; end if;
  return ws;
end $$;
revoke all on function public.owned_conversation_workspace(uuid) from public, anon, authenticated;

create function public.save_memory(p_conversation_id uuid, p_request_id uuid, p_kind text, p_statement text, p_quote text, p_sure boolean,
  p_valid_from date default null, p_valid_until date default null, p_replaces uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ws uuid := public.owned_conversation_workspace(p_conversation_id); saved public.memories%rowtype;
begin
  if not public.owner_said(ws, p_conversation_id, p_quote) then
    raise exception 'The quote must be words the owner wrote or said in this conversation' using errcode='22023';
  end if;
  if p_replaces is not null and not exists (select 1 from public.memories where id=p_replaces and workspace_id=ws and status='active' for update) then
    raise exception 'Only an active memory can be replaced' using errcode='22023';
  end if;
  insert into public.memories(workspace_id, kind, statement, quote, status, valid_from, valid_until, replaces, conversation_id, request_id, saved_by)
    values (ws, p_kind, btrim(p_statement), btrim(p_quote), case when p_sure then 'active' else 'suggested' end,
      p_valid_from, p_valid_until, p_replaces, p_conversation_id, p_request_id, 'ai')
    returning * into saved;
  if p_sure and p_replaces is not null then
    update public.memories set status='replaced', closed_at=now(), ended_on=p_valid_from where id=p_replaces;
  end if;
  return jsonb_build_object('id', saved.id, 'status', saved.status);
end $$;

create function public.end_memory(p_id uuid, p_ended_on date, p_conversation_id uuid default null, p_quote text default null)
returns void language plpgsql security definer set search_path='' as $$
declare target public.memories%rowtype;
begin
  select * into target from public.memories where id=p_id and public.owns_workspace(workspace_id) for update;
  if not found or target.status <> 'active' then raise exception 'Only an active memory can be ended' using errcode='22023'; end if;
  if p_conversation_id is not null and not public.owner_said(public.owned_conversation_workspace(p_conversation_id), p_conversation_id, p_quote) then
    raise exception 'The quote must be words the owner wrote or said in this conversation' using errcode='22023';
  end if;
  update public.memories set status='ended', closed_at=now(), ended_on=greatest(p_ended_on, valid_from) where id=p_id;
end $$;

create function public.confirm_memory(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare target public.memories%rowtype;
begin
  select * into target from public.memories where id=p_id and public.owns_workspace(workspace_id) for update;
  if not found or target.status <> 'suggested' then raise exception 'Only a suggested memory can be saved' using errcode='22023'; end if;
  if target.replaces is not null and exists (select 1 from public.memories where id=target.replaces and status='active' for update) then
    update public.memories set status='replaced', closed_at=now(), ended_on=target.valid_from where id=target.replaces;
  else
    target.replaces := null;
  end if;
  update public.memories set status='active', replaces=target.replaces where id=p_id;
end $$;

create function public.undo_memory(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare target public.memories%rowtype;
begin
  select * into target from public.memories where id=p_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Memory unavailable' using errcode='P0002'; end if;
  if target.status = 'ended' then
    update public.memories set status='active', closed_at=null, ended_on=null where id=p_id;
  elsif target.status in ('active','suggested') and target.saved_by = 'ai' then
    delete from public.memories where id=p_id;
    if target.status = 'active' and target.replaces is not null then
      update public.memories set status='active', closed_at=null, ended_on=null where id=target.replaces and status='replaced';
    end if;
  else
    raise exception 'This memory has changed since; edit it instead' using errcode='22023';
  end if;
end $$;

create function public.edit_memory(p_id uuid, p_kind text, p_statement text, p_valid_from date, p_valid_until date) returns uuid
language plpgsql security definer set search_path='' as $$
declare target public.memories%rowtype; edited uuid;
begin
  select * into target from public.memories where id=p_id and public.owns_workspace(workspace_id) for update;
  if not found or target.status <> 'active' then raise exception 'Only an active memory can be edited' using errcode='22023'; end if;
  update public.memories set status='replaced', closed_at=now(), ended_on=p_valid_from where id=p_id;
  insert into public.memories(workspace_id, kind, statement, status, valid_from, valid_until, replaces, saved_by)
    values (target.workspace_id, p_kind, btrim(p_statement), 'active', p_valid_from, p_valid_until, p_id, 'owner')
    returning id into edited;
  return edited;
end $$;

create function public.forget_memory(p_id uuid) returns integer language plpgsql security definer set search_path='' as $$
declare ws uuid; removed integer;
begin
  select workspace_id into ws from public.memories where id=p_id and public.owns_workspace(workspace_id);
  if ws is null then raise exception 'Memory unavailable' using errcode='P0002'; end if;
  with recursive chain(id) as (
    select p_id
    union
    select m.id from public.memories m join chain c on m.replaces=c.id or m.id=(select replaces from public.memories where id=c.id)
    where m.workspace_id=ws
  )
  delete from public.memories where id in (select id from chain);
  get diagnostics removed = row_count;
  return removed;
end $$;

revoke all on function public.save_memory(uuid,uuid,text,text,text,boolean,date,date,uuid), public.end_memory(uuid,date,uuid,text),
  public.confirm_memory(uuid), public.undo_memory(uuid), public.edit_memory(uuid,text,text,date,date), public.forget_memory(uuid) from public, anon;
grant execute on function public.save_memory(uuid,uuid,text,text,text,boolean,date,date,uuid), public.end_memory(uuid,date,uuid,text),
  public.confirm_memory(uuid), public.undo_memory(uuid), public.edit_memory(uuid,text,text,date,date), public.forget_memory(uuid) to authenticated, service_role;
