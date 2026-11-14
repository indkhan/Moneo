-- Who a payment is with, what the owner said about them, and what still needs the owner.
-- Identities are evidence built from the bank's data (creditor id, IBAN, names) and the description key;
-- aliases let different spellings resolve to one identity. Owner-confirmed memory is the only memory the
-- organizer trusts. Questions hold "needs you" items, one per identity. Nothing here sets a row's kind:
-- proven own transfers and exchanges go through the audited mark/link RPCs.

create table public.organize_identities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('merchant','person','processor','own_account','internal')),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 200),
  merchant_id uuid references public.merchants(id) on delete set null,
  created_by text not null default 'system' check (created_by in ('system','ai','owner')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index organize_identities_workspace on public.organize_identities(workspace_id);

-- One identity per (type, value) in a workspace. Values are normalized by lib/organize/identity.ts.
create table public.organize_identity_aliases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  identity_id uuid not null references public.organize_identities(id) on delete cascade,
  alias_type text not null check (alias_type in ('creditor_id','iban','card_merchant','counterparty_name','description_key')),
  value text not null check (char_length(value) between 1 and 1000),
  created_at timestamptz not null default now(),
  unique (workspace_id, alias_type, value)
);
create index organize_identity_aliases_identity on public.organize_identity_aliases(identity_id);

-- The identity a row was resolved to when it landed. Not financial data: setting it never bumps the version.
alter table public.transactions add column identity_id uuid references public.organize_identities(id) on delete set null;
create index transactions_identity_idx on public.transactions(identity_id) where identity_id is not null;

-- "Needs you": one question per identity (identity_key), from the landing checks ('system') or the organizer ('ai').
create table public.organize_questions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  identity_key text not null check (char_length(identity_key) between 1 and 1000),
  identity_id uuid references public.organize_identities(id) on delete set null,
  question text not null check (char_length(btrim(question)) between 1 and 500),
  transaction_ids uuid[] not null default '{}' check (cardinality(transaction_ids) <= 500),
  status text not null default 'open' check (status in ('open','answered','dismissed')),
  answer jsonb check (answer is null or (jsonb_typeof(answer) = 'object' and octet_length(answer::text) <= 8192)),
  created_by text not null check (created_by in ('system','ai')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  answered_at timestamptz,
  unique (workspace_id, identity_key)
);
create index organize_questions_open on public.organize_questions(workspace_id, created_at desc) where status = 'open';

-- What an identity is: a category and merchant, or for a person what the money is for. Only source 'owner'
-- (confirmed) is trusted; 'ai' rows are the organizer's own notes. `suppressed` lists category ids the owner rejected.
create table public.organize_memory (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  identity_id uuid not null references public.organize_identities(id) on delete cascade,
  category_id uuid references public.categories(id) on delete set null,
  merchant_id uuid references public.merchants(id) on delete set null,
  purpose text check (char_length(btrim(purpose)) between 1 and 200),
  source text not null check (source in ('owner','ai')),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  suppressed jsonb not null default '[]' check (jsonb_typeof(suppressed) = 'array' and jsonb_array_length(suppressed) <= 200),
  unique (workspace_id, identity_id),
  check (source <> 'owner' or confirmed_at is not null)
);

alter table public.organize_identities enable row level security;
alter table public.organize_identity_aliases enable row level security;
alter table public.organize_questions enable row level security;
alter table public.organize_memory enable row level security;
create policy organize_identities_owned on public.organize_identities for select using (public.owns_workspace(workspace_id));
create policy organize_identity_aliases_owned on public.organize_identity_aliases for select using (public.owns_workspace(workspace_id));
create policy organize_questions_owned on public.organize_questions for select using (public.owns_workspace(workspace_id));
create policy organize_memory_owned on public.organize_memory for select using (public.owns_workspace(workspace_id));
revoke all on public.organize_identities, public.organize_identity_aliases, public.organize_questions, public.organize_memory from anon, authenticated;
grant select on public.organize_identities, public.organize_identity_aliases, public.organize_questions, public.organize_memory to authenticated;
grant all on public.organize_identities, public.organize_identity_aliases, public.organize_questions, public.organize_memory to service_role;

-- Landing (service role): each item is one row with its candidate identity, aliases strongest first. The first alias
-- already known names the identity; otherwise a new one is made. Every alias not yet claimed joins it. Rows that
-- already have an identity keep it, so a rerun changes nothing.
create function public.resolve_organize_identities(p_workspace uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item jsonb; alias jsonb; found_identity uuid; tx public.transactions%rowtype; resolved integer:=0; created integer:=0;
begin
  if p_workspace is null or not exists(select 1 from public.workspaces where id=p_workspace) then raise exception 'Workspace not found' using errcode='P0002'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 500 then raise exception 'Invalid identities' using errcode='22023'; end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item)<>'object' or item-array['transaction_id','kind','display_name','aliases']<>'{}'::jsonb
      or jsonb_typeof(item->'transaction_id') is distinct from 'string'
      or coalesce(item->>'kind','') not in ('merchant','person','processor','own_account','internal')
      or jsonb_typeof(item->'display_name') is distinct from 'string' or char_length(btrim(item->>'display_name')) not between 1 and 200
      or jsonb_typeof(item->'aliases') is distinct from 'array' or jsonb_array_length(item->'aliases') not between 1 and 10
      or exists(select 1 from jsonb_array_elements(item->'aliases') a where jsonb_typeof(a)<>'object' or a-array['type','value']<>'{}'::jsonb
        or coalesce(a->>'type','') not in ('creditor_id','iban','card_merchant','counterparty_name','description_key')
        or jsonb_typeof(a->'value') is distinct from 'string' or char_length(a->>'value') not between 1 and 1000)
      then raise exception 'Invalid identity item' using errcode='22023'; end if;
  end loop;
  -- One resolver at a time per workspace, so two syncs never make two identities for one alias.
  perform pg_advisory_xact_lock(hashtextextended(p_workspace::text||':organize-identity',0));
  for item in select value from jsonb_array_elements(p_items) loop
    select * into tx from public.transactions where id=(item->>'transaction_id')::uuid and workspace_id=p_workspace;
    if not found or tx.identity_id is not null then continue; end if;
    found_identity := null;
    for alias in select value from jsonb_array_elements(item->'aliases') loop
      select identity_id into found_identity from public.organize_identity_aliases where workspace_id=p_workspace and alias_type=alias->>'type' and value=alias->>'value';
      exit when found_identity is not null;
    end loop;
    if found_identity is null then
      insert into public.organize_identities(workspace_id,kind,display_name) values(p_workspace,item->>'kind',btrim(item->>'display_name')) returning id into found_identity;
      created := created+1;
    end if;
    insert into public.organize_identity_aliases(workspace_id,identity_id,alias_type,value)
      select p_workspace,found_identity,a->>'type',a->>'value' from jsonb_array_elements(item->'aliases') a on conflict do nothing;
    update public.transactions set identity_id=found_identity where id=tx.id;
    resolved := resolved+1;
  end loop;
  return jsonb_build_object('resolved',resolved,'created',created);
end;
$$;
revoke all on function public.resolve_organize_identities(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.resolve_organize_identities(uuid,jsonb) to service_role;

-- Raises the question for an identity once. While it is open, new rows join it; once answered or dismissed it stays so.
create function public.raise_organize_question(p_workspace uuid, p_identity_key text, p_identity_id uuid, p_question text, p_transaction_ids uuid[], p_created_by text)
returns uuid language plpgsql security definer set search_path='' as $$
declare question_id uuid;
begin
  if p_workspace is null or not exists(select 1 from public.workspaces where id=p_workspace) then raise exception 'Workspace not found' using errcode='P0002'; end if;
  if p_created_by is null or p_created_by not in ('system','ai') or p_transaction_ids is null or cardinality(p_transaction_ids)>500 then raise exception 'Invalid question' using errcode='22023'; end if;
  if p_identity_id is not null and not exists(select 1 from public.organize_identities where id=p_identity_id and workspace_id=p_workspace) then raise exception 'Identity not found' using errcode='P0002'; end if;
  if (select count(*) from public.transactions where id=any(p_transaction_ids) and workspace_id=p_workspace)<>(select count(distinct id) from unnest(p_transaction_ids) id)
    then raise exception 'Transaction not found' using errcode='P0002'; end if;
  insert into public.organize_questions(workspace_id,identity_key,identity_id,question,transaction_ids,created_by)
    values(p_workspace,p_identity_key,p_identity_id,btrim(p_question),(select coalesce(array_agg(distinct id order by id),'{}') from unnest(p_transaction_ids) id),p_created_by)
    on conflict(workspace_id,identity_key) do update
      set transaction_ids=(select coalesce(array_agg(id order by id),'{}') from (select distinct id from unnest(public.organize_questions.transaction_ids||excluded.transaction_ids) id order by id limit 500) merged),
        identity_id=coalesce(public.organize_questions.identity_id,excluded.identity_id),updated_at=now()
      where public.organize_questions.status='open'
    returning id into question_id;
  if question_id is null then select id into question_id from public.organize_questions where workspace_id=p_workspace and identity_key=p_identity_key; end if;
  return question_id;
end;
$$;
revoke all on function public.raise_organize_question(uuid,text,uuid,text,uuid[],text) from public,anon,authenticated;
grant execute on function public.raise_organize_question(uuid,text,uuid,text,uuid[],text) to service_role;

-- The owner answers or dismisses an open question. What an answer does is decided by its caller.
create function public.answer_organize_question(p_question uuid, p_status text, p_answer jsonb default null)
returns public.organize_questions language plpgsql security definer set search_path='' as $$
declare q public.organize_questions%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_status is null or p_status not in ('answered','dismissed')
    or (p_status='answered' and (p_answer is null or jsonb_typeof(p_answer)<>'object' or octet_length(p_answer::text)>8192))
    then raise exception 'Invalid answer' using errcode='22023'; end if;
  select * into q from public.organize_questions where id=p_question and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Question not found' using errcode='P0002'; end if;
  if q.status<>'open' then raise exception 'This question was already answered' using errcode='22023'; end if;
  update public.organize_questions set status=p_status,answer=case when p_status='answered' then p_answer end,answered_at=now(),updated_at=now()
    where id=q.id returning * into q;
  return q;
end;
$$;
revoke all on function public.answer_organize_question(uuid,text,jsonb) from public,anon;
grant execute on function public.answer_organize_question(uuid,text,jsonb) to authenticated;

-- The owner says what an identity is. With p_apply_to_existing, that identity's rows that are blank or labelled by
-- the AI get the labels as one owner batch (correction events with a batch id), so the existing batch Undo takes
-- it back. Never rows the owner organized, corrected or split, never transfers, and never a processor identity
-- without its description (a processor's name alone says nothing about what was bought).
create function public.confirm_organize_memory(p_identity uuid, p_category uuid, p_merchant uuid, p_apply_to_existing boolean, p_purpose text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ident public.organize_identities%rowtype; memory_id uuid; ids uuid[]; selection jsonb; batch public.transaction_batches%rowtype;
  t public.transactions%rowtype; updated public.transactions%rowtype; purpose text:=nullif(btrim(p_purpose),'');
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into ident from public.organize_identities where id=p_identity and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Identity not found' using errcode='P0002'; end if;
  if p_category is null and p_merchant is null and purpose is null then raise exception 'Choose a category, merchant or purpose' using errcode='22023'; end if;
  if char_length(purpose)>200 then raise exception 'Purpose is too long' using errcode='22023'; end if;
  if p_category is not null and not exists(select 1 from public.categories where id=p_category and workspace_id=ident.workspace_id) then raise exception 'Category not found' using errcode='P0002'; end if;
  if p_merchant is not null and not exists(select 1 from public.merchants where id=p_merchant and workspace_id=ident.workspace_id) then raise exception 'Merchant not found' using errcode='P0002'; end if;
  if ident.kind='processor' and not exists(select 1 from public.organize_identity_aliases where identity_id=ident.id and alias_type='description_key')
    then raise exception 'A payment processor needs the payment''s description' using errcode='22023'; end if;
  insert into public.organize_memory(workspace_id,identity_id,category_id,merchant_id,purpose,source,confirmed_at)
    values(ident.workspace_id,ident.id,p_category,p_merchant,purpose,'owner',now())
    on conflict(workspace_id,identity_id) do update set category_id=excluded.category_id,merchant_id=excluded.merchant_id,purpose=excluded.purpose,
      source='owner',confirmed_at=now(),updated_at=now(),
      suppressed=(select coalesce(jsonb_agg(value),'[]') from jsonb_array_elements(public.organize_memory.suppressed) value where value is distinct from to_jsonb(excluded.category_id::text))
    returning id into memory_id;
  if p_merchant is not null then update public.organize_identities set merchant_id=p_merchant,updated_at=now() where id=ident.id; end if;
  if not coalesce(p_apply_to_existing,false) or (p_category is null and p_merchant is null) then
    return jsonb_build_object('memoryId',memory_id,'batchId',null,'applied',0);
  end if;
  -- Same lock order as the owner's bulk edits.
  perform 1 from public.transactions where workspace_id=ident.workspace_id and identity_id=ident.id order by id for update;
  select coalesce(array_agg(x.id order by x.id),'{}') into ids from public.transactions x
    where x.workspace_id=ident.workspace_id and x.identity_id=ident.id and x.kind<>'transfer'
      and (x.organized_by='ai' or (x.organized_by is null and x.category_id is null))
      and (x.category_id is distinct from coalesce(p_category,x.category_id) or x.merchant_id is distinct from coalesce(p_merchant,x.merchant_id))
      and not exists(select 1 from public.correction_events e where e.transaction_id=x.id and e.workspace_id=x.workspace_id and not e.undone and e.origin='owner'
        and ((e.before ? 'category_id' and e.after ? 'category_id' and e.before->'category_id' is distinct from e.after->'category_id')
          or (e.before ? 'merchant_id' and e.after ? 'merchant_id' and e.before->'merchant_id' is distinct from e.after->'merchant_id')))
      and not exists(select 1 from public.transaction_split_sets s where s.transaction_id=x.id and s.undone_at is null);
  if cardinality(ids)=0 then return jsonb_build_object('memoryId',memory_id,'batchId',null,'applied',0); end if;
  select jsonb_agg(jsonb_build_object('id',id,'version',version) order by id) into selection from public.transactions where id=any(ids);
  insert into public.transaction_batches(workspace_id,request_id,actor_id,selection,patch)
    values(ident.workspace_id,gen_random_uuid(),auth.uid(),selection,jsonb_strip_nulls(jsonb_build_object('category_id',p_category,'merchant_id',p_merchant))) returning * into batch;
  for t in select * from public.transactions where id=any(ids) order by id loop
    update public.transactions set category_id=coalesce(p_category,category_id),merchant_id=coalesce(p_merchant,merchant_id),version=version+1
      where id=t.id returning * into updated;
    -- The owner-organization trigger records the row's previous provenance in `before`, so Undo restores AI labels exactly.
    insert into public.correction_events(workspace_id,transaction_id,actor_id,before,after) values(ident.workspace_id,t.id,auth.uid(),
      jsonb_build_object('merchant_id',t.merchant_id,'category_id',t.category_id,'tags',t.tags,'event_name',t.event_name,'version',t.version),
      jsonb_build_object('merchant_id',updated.merchant_id,'category_id',updated.category_id,'tags',updated.tags,'event_name',updated.event_name,'version',updated.version,
        'operation','metadata','batch_id',batch.id,'memory_id',memory_id));
    update public.transactions set organized_by='memory' where id=t.id;
  end loop;
  return jsonb_build_object('memoryId',memory_id,'batchId',batch.id,'applied',cardinality(ids));
end;
$$;
revoke all on function public.confirm_organize_memory(uuid,uuid,uuid,boolean,text) from public,anon;
grant execute on function public.confirm_organize_memory(uuid,uuid,uuid,boolean,text) to authenticated;

-- A currency exchange between the owner's own money: each observed leg becomes a transfer, in its own currency and
-- amount. Legs in different currencies are not linked with transfer_id (that needs dated FX evidence, and Moneo never
-- invents a rate); the other leg, when present, is named in the audit as exchange_with. Same audit operation as the
-- other own-account marks, so undo_own_account_transfer restores each leg exactly.
create function public.mark_own_exchange(p_transaction_id uuid, p_expected_version integer, p_counterpart_id uuid default null)
returns public.transactions language plpgsql security definer set search_path='' as $$
declare actor uuid; old_row public.transactions%rowtype; new_row public.transactions%rowtype; other public.transactions%rowtype;
begin
  if auth.uid() is null and (select auth.jwt()->>'role') is distinct from 'service_role' then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into old_row from public.transactions where id=p_transaction_id and public.can_link_workspace(workspace_id) for update;
  if not found then raise exception 'Transaction not found' using errcode='P0002'; end if;
  actor := public.link_actor(old_row.workspace_id);
  if p_counterpart_id is not null then
    select * into other from public.transactions where id=p_counterpart_id and workspace_id=old_row.workspace_id;
    if not found then raise exception 'Other side not found' using errcode='P0002'; end if;
    if other.account_id=old_row.account_id or other.currency_code=old_row.currency_code or sign(other.amount_minor)=sign(old_row.amount_minor) or other.status<>'posted'
      then raise exception 'An exchange''s other side is an opposite posting in another currency' using errcode='22023'; end if;
  end if;
  if old_row.version is distinct from p_expected_version then raise exception 'Transaction changed; refresh and retry' using errcode='PT409'; end if;
  if old_row.status<>'posted' or old_row.kind<>'ordinary' or old_row.transfer_id is not null or old_row.refund_of_id is not null
    or old_row.amount_minor=0 or not (old_row.review_reasons <@ array['source_transfer','source_exchange']::text[])
    or exists(select 1 from public.transactions where refund_of_id=old_row.id or transfer_id=old_row.id)
    or exists(select 1 from public.transaction_split_sets where transaction_id=old_row.id and undone_at is null)
    or exists(select 1 from public.transaction_links where undone_at is null and (primary_transaction_id=old_row.id or counterpart_transaction_id=old_row.id))
  then raise exception 'Only posted, unlinked, unsplit transactions can be marked' using errcode='22023'; end if;
  update public.transactions set kind='transfer',review_reasons='{}',version=version+1 where id=old_row.id returning * into new_row;
  insert into public.correction_events(workspace_id,transaction_id,actor_id,before,after)
  values(old_row.workspace_id,old_row.id,actor,
    jsonb_build_object('category_id',old_row.category_id,'note',old_row.note,'kind',old_row.kind,'transfer_id',old_row.transfer_id,
      'refund_of_id',old_row.refund_of_id,'review_reasons',to_jsonb(old_row.review_reasons),'version',old_row.version),
    jsonb_build_object('category_id',new_row.category_id,'note',new_row.note,'kind',new_row.kind,'transfer_id',new_row.transfer_id,
      'refund_of_id',new_row.refund_of_id,'review_reasons',to_jsonb(new_row.review_reasons),'version',new_row.version,
      'operation','own_account_transfer','identifier_id',null,'own_account','Currency exchange','rule','exchange','exchange_with',p_counterpart_id));
  return new_row;
end;
$$;
revoke all on function public.mark_own_exchange(uuid,integer,uuid) from public,anon;
grant execute on function public.mark_own_exchange(uuid,integer,uuid) to authenticated,service_role;
