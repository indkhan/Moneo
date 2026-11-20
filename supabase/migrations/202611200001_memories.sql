create function public.memory_text(value text) returns text language sql immutable set search_path='' as $$
  select btrim(regexp_replace(lower(translate(coalesce(value, ''), '’‘“”', '''''""')), '\s+', ' ', 'g'))
$$;

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('pledge','plan','fact','explanation','preference')),
  statement text not null check (length(btrim(statement)) between 1 and 500),
  quote text check (length(btrim(quote)) between 1 and 500),
  status text not null default 'active' check (status in ('suggested','active','replaced','ended','declined')),
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
  check ((status in ('replaced','ended','declined')) = (closed_at is not null)),
  check (saved_by = 'owner' or quote is not null)
);
create index memories_workspace_status on public.memories(workspace_id, status, created_at desc);
create index memories_search on public.memories using gin(search);
create index memories_conversation on public.memories(conversation_id) where conversation_id is not null;
create unique index memories_one_current_copy on public.memories(workspace_id, kind, public.memory_text(statement)) where status in ('active','suggested');
create unique index memories_replaced_once on public.memories(replaces) where replaces is not null and status <> 'suggested';

alter table public.memories enable row level security;
create policy own_memories on public.memories for select to authenticated using (workspace_id in (select public.owned_workspace_ids()));
grant select on public.memories to authenticated;
grant all on public.memories to service_role;

create function public.owner_said(p_workspace_id uuid, p_request_id uuid, p_quote text) returns boolean language sql stable security definer set search_path='' as $$
  select coalesce(array_length(string_to_array(public.memory_text(p_quote), ' '), 1), 0) >= 3 and (
    exists (select 1 from public.chat_requests r where r.id=p_request_id and r.workspace_id=p_workspace_id
      and position(public.memory_text(p_quote) in public.memory_text(r.message)) > 0)
    or exists (select 1 from public.chat_steers s where s.chat_request_id=p_request_id and s.workspace_id=p_workspace_id
      and position(public.memory_text(p_quote) in public.memory_text(s.content)) > 0))
$$;
revoke all on function public.owner_said(uuid,uuid,text) from public, anon, authenticated;

create function public.request_workspace(p_request_id uuid) returns uuid language plpgsql stable security definer set search_path='' as $$
declare ws uuid;
begin
  select r.workspace_id into ws from public.chat_requests r join public.conversations c on c.id=r.conversation_id
    where r.id=p_request_id and c.deleted_at is null and public.owns_workspace(r.workspace_id);
  if ws is null then raise exception 'Chat request unavailable' using errcode='42501'; end if;
  return ws;
end $$;
revoke all on function public.request_workspace(uuid) from public, anon, authenticated;

create function public.replaced_on(p_old_from date, p_new_from date, p_today date) returns date language sql immutable set search_path='' as $$
  select greatest(coalesce(p_new_from - 1, p_today), p_old_from)
$$;

create function public.save_memory(p_request_id uuid, p_kind text, p_statement text, p_quote text, p_sure boolean, p_today date,
  p_valid_from date default null, p_valid_until date default null, p_replaces uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ws uuid := public.request_workspace(p_request_id); saved public.memories%rowtype; old public.memories%rowtype;
begin
  if not public.owner_said(ws, p_request_id, p_quote) then
    raise exception 'The quote must be at least three words the owner wrote or said in this message' using errcode='22023';
  end if;
  select * into saved from public.memories where workspace_id=ws and kind=p_kind and public.memory_text(statement)=public.memory_text(p_statement)
    and (status in ('active','suggested') or (status='declined' and closed_at > now() - interval '180 days'))
    order by status='declined' limit 1;
  if found then return jsonb_build_object('id', saved.id, 'status', saved.status, 'alreadyKnown', true); end if;
  if p_replaces is not null then
    select * into old from public.memories where id=p_replaces and workspace_id=ws for update;
    if not found or old.status <> 'active' then raise exception 'Only an active memory can be replaced' using errcode='22023'; end if;
  end if;
  begin
    insert into public.memories(workspace_id, kind, statement, quote, status, valid_from, valid_until, replaces, conversation_id, request_id, saved_by)
      select ws, p_kind, btrim(p_statement), btrim(p_quote), case when p_sure then 'active' else 'suggested' end,
        p_valid_from, p_valid_until, p_replaces, r.conversation_id, p_request_id, 'ai' from public.chat_requests r where r.id=p_request_id
      returning * into saved;
  exception when unique_violation then
    select * into saved from public.memories where workspace_id=ws and kind=p_kind and status in ('active','suggested')
      and public.memory_text(statement)=public.memory_text(p_statement);
    if not found then raise exception 'Only an active memory can be replaced' using errcode='22023'; end if;
    return jsonb_build_object('id', saved.id, 'status', saved.status, 'alreadyKnown', true);
  end;
  if p_sure and p_replaces is not null then
    update public.memories set status='replaced', closed_at=now(), ended_on=public.replaced_on(old.valid_from, p_valid_from, p_today) where id=p_replaces;
  end if;
  return jsonb_build_object('id', saved.id, 'status', saved.status, 'alreadyKnown', false);
end $$;

create function public.end_memory(p_id uuid, p_ended_on date, p_today date, p_request_id uuid default null, p_quote text default null)
returns void language plpgsql security definer set search_path='' as $$
declare target public.memories%rowtype;
begin
  select * into target from public.memories where id=p_id and public.owns_workspace(workspace_id) for update;
  if not found or target.status <> 'active' then raise exception 'Only an active memory can be ended' using errcode='22023'; end if;
  if p_request_id is not null and (public.request_workspace(p_request_id) <> target.workspace_id or not public.owner_said(target.workspace_id, p_request_id, p_quote)) then
    raise exception 'The quote must be at least three words the owner wrote or said in this message' using errcode='22023';
  end if;
  if p_ended_on > p_today then
    update public.memories set valid_until=greatest(p_ended_on, valid_from) where id=p_id;
  else
    update public.memories set status='ended', closed_at=now(), ended_on=greatest(p_ended_on, valid_from) where id=p_id;
  end if;
end $$;

create function public.confirm_memory(p_id uuid, p_today date) returns void language plpgsql security definer set search_path='' as $$
declare target public.memories%rowtype; old public.memories%rowtype;
begin
  select * into target from public.memories where id=p_id and public.owns_workspace(workspace_id) for update;
  if not found or target.status <> 'suggested' then raise exception 'Only a suggested memory can be saved' using errcode='22023'; end if;
  if target.replaces is not null then
    select * into old from public.memories where id=target.replaces for update;
    if not found or old.status <> 'active' then
      raise exception 'What this would replace has changed since. Tell Moneo again if it is still true' using errcode='22023';
    end if;
    update public.memories set status='replaced', closed_at=now(), ended_on=public.replaced_on(old.valid_from, target.valid_from, p_today) where id=old.id;
  end if;
  update public.memories set status='active' where id=p_id;
exception when unique_violation then
  raise exception 'Moneo already remembers this; edit that memory instead' using errcode='22023';
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
exception when unique_violation then
  raise exception 'Moneo already remembers this again since; edit that memory instead' using errcode='22023';
end $$;

create function public.decline_memory(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  update public.memories set status='declined', closed_at=now() where id=p_id and status='suggested' and public.owns_workspace(workspace_id);
  if not found then raise exception 'Only a suggested memory can be declined' using errcode='22023'; end if;
end $$;

create function public.edit_memory(p_id uuid, p_kind text, p_statement text, p_valid_from date, p_valid_until date) returns uuid
language plpgsql security definer set search_path='' as $$
declare target public.memories%rowtype; edited uuid;
begin
  select * into target from public.memories where id=p_id and public.owns_workspace(workspace_id) for update;
  if not found or target.status <> 'active' then raise exception 'Only an active memory can be edited' using errcode='22023'; end if;
  update public.memories set status='replaced', closed_at=now(), ended_on=null where id=p_id;
  insert into public.memories(workspace_id, kind, statement, status, valid_from, valid_until, replaces, saved_by)
    values (target.workspace_id, p_kind, btrim(p_statement), 'active', p_valid_from, p_valid_until, p_id, 'owner')
    returning id into edited;
  return edited;
exception when unique_violation then
  raise exception 'Moneo already remembers this; edit or forget that memory instead' using errcode='22023';
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

revoke all on function public.save_memory(uuid,text,text,text,boolean,date,date,date,uuid), public.end_memory(uuid,date,date,uuid,text),
  public.confirm_memory(uuid,date), public.undo_memory(uuid), public.decline_memory(uuid), public.edit_memory(uuid,text,text,date,date), public.forget_memory(uuid) from public, anon;
grant execute on function public.save_memory(uuid,text,text,text,boolean,date,date,date,uuid), public.end_memory(uuid,date,date,uuid,text),
  public.confirm_memory(uuid,date), public.undo_memory(uuid), public.decline_memory(uuid), public.edit_memory(uuid,text,text,date,date), public.forget_memory(uuid) to authenticated, service_role;
