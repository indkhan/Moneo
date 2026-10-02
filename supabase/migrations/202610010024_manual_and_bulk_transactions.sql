alter table public.transactions add column tags text[] not null default '{}';
alter table public.transactions add column event_name text;
alter table public.transactions add constraint transactions_tags_count check(cardinality(tags) <= 20);
alter table public.transactions add constraint transactions_event_name_length check(length(event_name) <= 120);

-- Manual source evidence survives undo; the canonical unsourced entry alone is removed.
create table public.manual_transaction_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  transaction_id uuid references public.transactions(id) on delete set null,
  request_id uuid not null,
  actor_id uuid not null references auth.users(id),
  original_record jsonb not null,
  version integer not null default 0,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references auth.users(id),
  unique(workspace_id,request_id)
);
create table public.transaction_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_id uuid not null,
  actor_id uuid not null references auth.users(id),
  selection jsonb not null,
  patch jsonb not null,
  created_at timestamptz not null default now(),
  undone boolean not null default false,
  unique(workspace_id,request_id)
);
alter table public.manual_transaction_entries enable row level security;
alter table public.transaction_batches enable row level security;
create policy own_manual_entries on public.manual_transaction_entries for select to authenticated using(public.owns_workspace(workspace_id));
create policy own_transaction_batches on public.transaction_batches for select to authenticated using(public.owns_workspace(workspace_id));
revoke all on public.manual_transaction_entries, public.transaction_batches from public, authenticated;
grant select on public.manual_transaction_entries, public.transaction_batches to authenticated;

create function public.create_manual_transaction(p_account_id uuid,p_posted_on date,p_description text,p_amount_minor text,p_status text,p_category_id uuid,p_note text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account public.accounts%rowtype;
  transaction public.transactions%rowtype;
  entry public.manual_transaction_entries%rowtype;
  original jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_posted_on is null or p_description is null or length(btrim(p_description)) not between 1 and 500 or p_note is null or length(p_note)>2000
    or p_amount_minor is null or p_amount_minor !~ '^-?[0-9]+$' or length(p_amount_minor)>20 or p_status is null or p_status not in('posted','pending') or p_request_id is null
    then raise exception 'Invalid manual transaction' using errcode = '22023'; end if;
  select * into account from public.accounts where id=p_account_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Account not found' using errcode = 'P0002'; end if;
  if p_category_id is not null and not exists(select 1 from public.categories where id=p_category_id and workspace_id=account.workspace_id)
    then raise exception 'Category not found' using errcode = 'P0002'; end if;
  original := jsonb_build_object('account_id',p_account_id,'posted_on',p_posted_on,'description',btrim(p_description),'amount_minor',(p_amount_minor::bigint)::text,
    'currency_code',account.currency_code,'status',p_status,'kind','ordinary','category_id',p_category_id,'note',p_note);
  select * into entry from public.manual_transaction_entries where workspace_id=account.workspace_id and request_id=p_request_id;
  if found then
    if not entry.original_record @> original then raise exception 'Request ID reused for another transaction' using errcode = '22023'; end if;
    return jsonb_build_object('id',entry.transaction_id,'entryId',entry.id,'undone',entry.undone_at is not null);
  end if;
  insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind,category_id,note)
    values(account.workspace_id,p_account_id,p_posted_on,btrim(p_description),p_amount_minor::bigint,account.currency_code,p_status,'ordinary',p_category_id,p_note)
    returning * into transaction;
  original := to_jsonb(transaction)||jsonb_build_object('amount_minor',transaction.amount_minor::text);
  insert into public.manual_transaction_entries(workspace_id,transaction_id,request_id,actor_id,original_record)
    values(account.workspace_id,transaction.id,p_request_id,auth.uid(),original) returning * into entry;
  return jsonb_build_object('id',transaction.id,'entryId',entry.id,'undone',false);
end;
$$;

create function public.undo_manual_transaction(p_entry_id uuid,p_entry_version integer,p_expected_version integer)
returns void language plpgsql security definer set search_path = '' as $$
declare entry public.manual_transaction_entries%rowtype; transaction public.transactions%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into entry from public.manual_transaction_entries where id=p_entry_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Manual entry not found' using errcode = 'P0002'; end if;
  if entry.undone_at is not null then return; end if;
  if entry.version is distinct from p_entry_version then raise exception 'Manual entry changed' using errcode = '40001'; end if;
  select * into transaction from public.transactions where id=entry.transaction_id and workspace_id=entry.workspace_id for update;
  if not found or transaction.version is distinct from p_expected_version or transaction.version<>0 or transaction.transfer_id is not null or transaction.refund_of_id is not null
    or (to_jsonb(transaction)||jsonb_build_object('amount_minor',transaction.amount_minor::text)) is distinct from
      (to_jsonb(jsonb_populate_record(null::public.transactions,entry.original_record))||jsonb_build_object('amount_minor',entry.original_record->>'amount_minor'))
    or exists(select 1 from public.transactions where transfer_id=transaction.id or refund_of_id=transaction.id)
    or exists(select 1 from public.transaction_sources where transaction_id=transaction.id)
    or exists(select 1 from public.correction_events where transaction_id=transaction.id)
    or exists(select 1 from public.recurring_series_transactions where transaction_id=transaction.id)
    then raise exception 'Manual transaction has later changes, sources or links; preserve its evidence' using errcode = '40001'; end if;
  update public.manual_transaction_entries set undone_at=now(),undone_by=auth.uid(),version=version+1 where id=entry.id;
  delete from public.transactions where id=transaction.id;
end;
$$;

create function public.restore_manual_transaction(p_entry_id uuid,p_entry_version integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare entry public.manual_transaction_entries%rowtype; original public.transactions%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into entry from public.manual_transaction_entries where id=p_entry_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Manual entry not found' using errcode = 'P0002'; end if;
  if entry.undone_at is null then return entry.transaction_id; end if;
  if entry.version is distinct from p_entry_version then raise exception 'Manual entry changed' using errcode = '40001'; end if;
  original := jsonb_populate_record(null::public.transactions,entry.original_record);
  if not exists(select 1 from public.accounts where id=original.account_id and workspace_id=entry.workspace_id)
    or (original.category_id is not null and not exists(select 1 from public.categories where id=original.category_id and workspace_id=entry.workspace_id))
    then raise exception 'Original account or category is missing' using errcode = 'P0002'; end if;
  insert into public.transactions select original.*;
  update public.manual_transaction_entries set transaction_id=original.id,undone_at=null,undone_by=null,version=version+1 where id=entry.id;
  return original.id;
end;
$$;

create function public.bulk_edit_transactions(p_rows jsonb,p_patch jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  transaction public.transactions%rowtype;
  updated public.transactions%rowtype;
  target jsonb;
  ids uuid[];
  workspace uuid;
  batch public.transaction_batches%rowtype;
  tag_values text[];
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_request_id is null or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 50
    or p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch='{}'::jsonb or p_patch-array['category_id','tags','event_name']<>'{}'::jsonb
    then raise exception 'Invalid bounded transaction edit' using errcode = '22023'; end if;
  for target in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(target)<>'object' or target-array['id','version']<>'{}'::jsonb or jsonb_typeof(target->'id') is distinct from 'string'
      or jsonb_typeof(target->'version') is distinct from 'number' or target->>'version' !~ '^[0-9]+$'
      then raise exception 'Selection requires IDs and integer versions' using errcode = '22023'; end if;
  end loop;
  select array_agg((value->>'id')::uuid) into ids from jsonb_array_elements(p_rows);
  if cardinality(ids)<>(select count(distinct id) from unnest(ids) id) then raise exception 'Duplicate transaction selection' using errcode = '22023'; end if;
  p_rows := (select jsonb_agg(value order by value->>'id') from jsonb_array_elements(p_rows));
  -- One lock order for all bulk edits prevents sibling selections deadlocking each other.
  for transaction in select * from public.transactions where id=any(ids) and public.owns_workspace(workspace_id) order by id for update loop
    if workspace is not null and transaction.workspace_id<>workspace then raise exception 'Transactions must share a workspace' using errcode = '22023'; end if;
    workspace := transaction.workspace_id;
  end loop;
  if workspace is null or (select count(*) from public.transactions where id=any(ids) and workspace_id=workspace)<>cardinality(ids)
    then raise exception 'Selected transaction not found' using errcode = 'P0002'; end if;
  if p_patch ? 'category_id' and p_patch->'category_id'<>'null'::jsonb and not exists(select 1 from public.categories where id=(p_patch->>'category_id')::uuid and workspace_id=workspace)
    then raise exception 'Category not found' using errcode = 'P0002'; end if;
  if p_patch ? 'tags' then
    if jsonb_typeof(p_patch->'tags') is distinct from 'array' or jsonb_array_length(p_patch->'tags')>20
      then raise exception 'At most 20 tags allowed' using errcode = '22023'; end if;
    if exists(select 1 from jsonb_array_elements(p_patch->'tags') tag where jsonb_typeof(tag)<>'string' or length(btrim(tag #>> '{}')) not between 1 and 40)
      then raise exception 'Invalid tag' using errcode = '22023'; end if;
    select array_agg(tag order by tag) into tag_values from(select distinct lower(btrim(value)) tag from jsonb_array_elements_text(p_patch->'tags')) normalized;
    tag_values := coalesce(tag_values,'{}');
    p_patch := jsonb_set(p_patch,'{tags}',to_jsonb(tag_values));
  end if;
  if p_patch ? 'event_name' then
    if p_patch->'event_name'<>'null'::jsonb and (jsonb_typeof(p_patch->'event_name')<>'string' or length(btrim(p_patch->>'event_name'))>120)
      then raise exception 'Invalid event name' using errcode = '22023'; end if;
    p_patch := jsonb_set(p_patch,'{event_name}',coalesce(to_jsonb(nullif(btrim(p_patch->>'event_name'),'')),'null'::jsonb));
  end if;
  select * into batch from public.transaction_batches where workspace_id=workspace and request_id=p_request_id;
  if found then
    if batch.selection<>p_rows or batch.patch<>p_patch then raise exception 'Request ID reused for another bulk edit' using errcode = '22023'; end if;
    return jsonb_build_object('batchId',batch.id,'count',cardinality(ids),'undone',batch.undone);
  end if;
  insert into public.transaction_batches(workspace_id,request_id,actor_id,selection,patch) values(workspace,p_request_id,auth.uid(),p_rows,p_patch) returning * into batch;
  for target in select value from jsonb_array_elements(p_rows) loop
    select * into transaction from public.transactions where id=(target->>'id')::uuid;
    if transaction.version is distinct from (target->>'version')::integer then raise exception 'A selected transaction changed; reload the preview' using errcode = '40001'; end if;
    update public.transactions set category_id=case when p_patch ? 'category_id' then (p_patch->>'category_id')::uuid else category_id end,
      tags=case when p_patch ? 'tags' then tag_values else tags end,
      event_name=case when p_patch ? 'event_name' then p_patch->>'event_name' else event_name end,version=version+1
      where id=transaction.id returning * into updated;
    insert into public.correction_events(workspace_id,transaction_id,actor_id,before,after) values(workspace,transaction.id,auth.uid(),
      jsonb_build_object('category_id',transaction.category_id,'tags',transaction.tags,'event_name',transaction.event_name,'version',transaction.version),
      jsonb_build_object('category_id',updated.category_id,'tags',updated.tags,'event_name',updated.event_name,'version',updated.version,'operation','metadata','batch_id',batch.id));
  end loop;
  return jsonb_build_object('batchId',batch.id,'count',cardinality(ids),'undone',false);
end;
$$;

create function public.undo_transaction_metadata(p_event_id uuid,p_expected_version integer)
returns void language plpgsql security definer set search_path = '' as $$
declare event public.correction_events%rowtype; transaction public.transactions%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into event from public.correction_events where id=p_event_id and public.owns_workspace(workspace_id);
  if not found or event.after->>'operation' is distinct from 'metadata' then raise exception 'Metadata correction not found' using errcode = 'P0002'; end if;
  select * into transaction from public.transactions where id=event.transaction_id and workspace_id=event.workspace_id for update;
  if event.undone then return; end if;
  if transaction.version is distinct from p_expected_version or transaction.category_id is distinct from (event.after->>'category_id')::uuid
    or to_jsonb(transaction.tags) is distinct from event.after->'tags' or transaction.event_name is distinct from event.after->>'event_name'
    or exists(select 1 from public.correction_events where transaction_id=transaction.id and not undone and (after->>'version')::integer>(event.after->>'version')::integer)
    then raise exception 'Transaction changed; undo latest correction first' using errcode = '40001'; end if;
  update public.transactions set category_id=(event.before->>'category_id')::uuid,tags=array(select jsonb_array_elements_text(event.before->'tags')),
    event_name=event.before->>'event_name',version=version+1 where id=transaction.id;
  update public.correction_events set undone=true where id=event.id;
end;
$$;

create function public.undo_transaction_batch(p_batch_id uuid,p_rows jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare batch public.transaction_batches%rowtype; target jsonb; event public.correction_events%rowtype; ids uuid[];
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into batch from public.transaction_batches where id=p_batch_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Batch not found' using errcode = 'P0002'; end if;
  if batch.undone then return; end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)<>jsonb_array_length(batch.selection) then raise exception 'Full batch selection required' using errcode = '22023'; end if;
  for target in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(target)<>'object' or target-array['id','version']<>'{}'::jsonb or jsonb_typeof(target->'id') is distinct from 'string'
      or jsonb_typeof(target->'version') is distinct from 'number' or target->>'version' !~ '^[0-9]+$'
      then raise exception 'Selection requires IDs and integer versions' using errcode = '22023'; end if;
  end loop;
  select array_agg((value->>'id')::uuid) into ids from jsonb_array_elements(batch.selection);
  if (select count(distinct (value->>'id')::uuid) from jsonb_array_elements(p_rows) where (value->>'id')::uuid=any(ids))<>cardinality(ids) then raise exception 'Full batch selection required' using errcode = '22023'; end if;
  perform id from public.transactions where id=any(ids) and workspace_id=batch.workspace_id order by id for update;
  select * into batch from public.transaction_batches where id=p_batch_id for update;
  if batch.undone then return; end if;
  for target in select value from jsonb_array_elements(p_rows) order by value->>'id' loop
    select * into event from public.correction_events where transaction_id=(target->>'id')::uuid and workspace_id=batch.workspace_id and after->>'batch_id'=batch.id::text;
    if not found then raise exception 'Batch correction missing' using errcode = 'P0002'; end if;
    perform public.undo_transaction_metadata(event.id,(target->>'version')::integer);
  end loop;
  update public.transaction_batches set undone=true where id=batch.id;
end;
$$;

revoke all on function public.create_manual_transaction(uuid,date,text,text,text,uuid,text,uuid),public.undo_manual_transaction(uuid,integer,integer),public.restore_manual_transaction(uuid,integer),public.bulk_edit_transactions(jsonb,jsonb,uuid),public.undo_transaction_metadata(uuid,integer),public.undo_transaction_batch(uuid,jsonb) from public;
revoke insert on public.transactions from authenticated;
grant execute on function public.create_manual_transaction(uuid,date,text,text,text,uuid,text,uuid),public.undo_manual_transaction(uuid,integer,integer),public.restore_manual_transaction(uuid,integer),public.bulk_edit_transactions(jsonb,jsonb,uuid),public.undo_transaction_metadata(uuid,integer),public.undo_transaction_batch(uuid,jsonb) to authenticated;
