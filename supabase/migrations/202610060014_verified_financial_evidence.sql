-- Trusted server calculations create immutable query receipts. Owners can read,
-- but cannot forge receipts by inserting or editing a JSON payload from the client.
create table public.financial_evidence_receipts (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  scopes text[] not null,
  receipt jsonb not null,
  created_at timestamptz not null default now(),
  constraint financial_evidence_receipts_scopes_check check (cardinality(scopes) between 0 and 4 and scopes <@ array['accounts','transactions','planning','imports']::text[]),
  constraint financial_evidence_receipts_payload_check check ((jsonb_typeof(receipt) = 'object' and octet_length(receipt::text) <= 16777216
    and receipt->>'id' = id::text and receipt->>'workspaceId' = workspace_id::text
    and jsonb_typeof(receipt->'query') = 'object' and jsonb_typeof(receipt->'metrics') = 'array'
    and jsonb_typeof(receipt->'sources') = 'array' and receipt->'scopes' = to_jsonb(scopes)) is true)
);
create index financial_evidence_receipts_workspace_created on public.financial_evidence_receipts(workspace_id,created_at);
alter table public.financial_evidence_receipts enable row level security;
revoke all on public.financial_evidence_receipts from public,anon,authenticated;
grant select on public.financial_evidence_receipts to authenticated;
grant select,insert,delete on public.financial_evidence_receipts to service_role;
create policy financial_evidence_receipts_owner_read on public.financial_evidence_receipts for select to authenticated
  using (public.owns_workspace(workspace_id) and scopes <@ coalesce((select settings.ai_data_scopes from public.workspace_settings settings where settings.workspace_id=financial_evidence_receipts.workspace_id),array['accounts','transactions','planning','imports']::text[]));
create function public.prevent_financial_evidence_update() returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'Financial evidence receipts are immutable' using errcode='55000';
end;
$$;
revoke all on function public.prevent_financial_evidence_update() from public,anon,authenticated;
create trigger financial_evidence_receipts_immutable before update on public.financial_evidence_receipts
  for each row execute function public.prevent_financial_evidence_update();

-- Verified chat publication: clients retain failure/cancellation authority, but
-- successful assistant content and provider usage come only from server validation.
create or replace function public.finish_chat_request(p_request_id uuid,p_status text,p_content text,p_usage jsonb default null)
returns text language plpgsql security definer set search_path='' as $$
declare request_row public.chat_requests%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_status='completed' or p_usage is not null then
    raise exception 'Successful chat publication requires trusted validation' using errcode='42501';
  end if;
  if p_status is distinct from 'failed' or p_content is null or length(p_content)>20000 then
    raise exception 'Invalid chat completion' using errcode='22023';
  end if;
  select * into request_row from public.chat_requests where id=p_request_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Chat request not found' using errcode='P0002'; end if;
  if request_row.status<>'running' then return request_row.status; end if;
  update public.chat_requests set status='failed',error=left(p_content,500),updated_at=now() where id=p_request_id;
  return 'failed';
end;
$$;

create function public.finish_verified_chat_request(p_request_id uuid,p_actor_id uuid,p_workspace_id uuid,p_content text,p_receipt_ids uuid[],p_scopes text[],p_usage jsonb default null)
returns text language plpgsql security definer set search_path='' as $$
declare request_row public.chat_requests%rowtype; current_scopes text[]; token_key text;
begin
  if auth.role() is distinct from 'service_role' or p_actor_id is null then
    raise exception 'Trusted publication actor required' using errcode='42501';
  end if;
  if p_content is null or length(p_content)>20000 or p_receipt_ids is null or cardinality(p_receipt_ids)>1000
    or array_position(p_receipt_ids,null) is not null or p_scopes is null or cardinality(p_scopes)>4
    or array_position(p_scopes,null) is not null or not(p_scopes <@ array['accounts','transactions','planning','imports']::text[]) then
    raise exception 'Invalid verified publication' using errcode='22023';
  end if;
  -- This lock also serializes a previously absent settings row's FK insertion.
  perform 1 from public.workspaces where id=p_workspace_id and owner_id=p_actor_id for update;
  if not found then raise exception 'Chat workspace not found' using errcode='P0002'; end if;
  select ai_data_scopes into current_scopes from public.workspace_settings where workspace_id=p_workspace_id for share;
  if not found then current_scopes:=array['accounts','transactions','planning','imports']::text[]; end if;
  if not(p_scopes <@ current_scopes) or exists(
    select 1 from unnest(p_receipt_ids) selected(id) left join public.financial_evidence_receipts receipt
      on receipt.id=selected.id and receipt.workspace_id=p_workspace_id
    where receipt.id is null or not(receipt.scopes <@ p_scopes)
  ) then raise exception 'Evidence permissions changed' using errcode='42501'; end if;
  if p_usage is not null then
    if jsonb_typeof(p_usage)<>'object' or p_usage-array['model_id','input_tokens','output_tokens','total_tokens']<>'{}'::jsonb
      or jsonb_typeof(p_usage->'model_id') is distinct from 'string' or length(p_usage->>'model_id') not between 1 and 200 then
      raise exception 'Invalid provider usage' using errcode='22023'; end if;
    foreach token_key in array array['input_tokens','output_tokens','total_tokens'] loop
      if p_usage ? token_key and p_usage->token_key<>'null'::jsonb and
        (jsonb_typeof(p_usage->token_key)<>'number' or p_usage->>token_key !~ '^[0-9]+$' or (p_usage->>token_key)::numeric>9007199254740991) then
        raise exception 'Invalid token count' using errcode='22023'; end if;
    end loop;
  end if;
  select * into request_row from public.chat_requests where id=p_request_id and workspace_id=p_workspace_id for update;
  if not found then raise exception 'Chat request not found' using errcode='P0002'; end if;
  if request_row.status<>'running' then return request_row.status; end if;
  insert into public.messages(workspace_id,conversation_id,role,content,reply_to)
    values(request_row.workspace_id,request_row.conversation_id,'assistant',p_content,p_request_id);
  update public.chat_requests set status='completed',answer=p_content,usage=p_usage,updated_at=now() where id=p_request_id;
  return 'completed';
end;
$$;
revoke all on function public.finish_verified_chat_request(uuid,uuid,uuid,text,uuid[],text[],jsonb) from public,anon,authenticated;
grant execute on function public.finish_verified_chat_request(uuid,uuid,uuid,text,uuid[],text[],jsonb) to service_role;

-- Owners cannot insert or rewrite saved assistant content through table access.
drop policy own_messages on public.messages;
create policy own_messages_read on public.messages for select to authenticated using(public.owns_workspace(workspace_id));
create policy own_messages_delete on public.messages for delete to authenticated using(public.owns_workspace(workspace_id));
create policy own_user_messages_insert on public.messages for insert to authenticated with check(
  role='user' and public.owns_workspace(workspace_id) and exists(select 1 from public.conversations where id=conversation_id and workspace_id=messages.workspace_id));
create policy own_user_messages_update on public.messages for update to authenticated using(role='user' and public.owns_workspace(workspace_id)) with check(
  role='user' and public.owns_workspace(workspace_id) and exists(select 1 from public.conversations where id=conversation_id and workspace_id=messages.workspace_id));
