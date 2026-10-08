-- Owned merchant/category organization uses the existing atomic metadata batch and guarded Undo.
-- Existing receipts without merchant fields retain their original Undo semantics.
create or replace function public.bulk_edit_transactions(p_rows jsonb,p_patch jsonb,p_request_id uuid)
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
    or p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch='{}'::jsonb or p_patch-array['category_id','merchant_id','tags','event_name']<>'{}'::jsonb
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
  if p_patch ? 'merchant_id' and p_patch->'merchant_id'<>'null'::jsonb and not exists(select 1 from public.merchants where id=(p_patch->>'merchant_id')::uuid and workspace_id=workspace)
    then raise exception 'Merchant not found' using errcode = 'P0002'; end if;
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
    update public.transactions set merchant_id=case when p_patch ? 'merchant_id' then (p_patch->>'merchant_id')::uuid else merchant_id end,
      category_id=case when p_patch ? 'category_id' then (p_patch->>'category_id')::uuid else category_id end,
      tags=case when p_patch ? 'tags' then tag_values else tags end,
      event_name=case when p_patch ? 'event_name' then p_patch->>'event_name' else event_name end,version=version+1
      where id=transaction.id returning * into updated;
    insert into public.correction_events(workspace_id,transaction_id,actor_id,before,after) values(workspace,transaction.id,auth.uid(),
      jsonb_build_object('merchant_id',transaction.merchant_id,'category_id',transaction.category_id,'tags',transaction.tags,'event_name',transaction.event_name,'version',transaction.version),
      jsonb_build_object('merchant_id',updated.merchant_id,'category_id',updated.category_id,'tags',updated.tags,'event_name',updated.event_name,'version',updated.version,'operation','metadata','batch_id',batch.id));
  end loop;
  return jsonb_build_object('batchId',batch.id,'count',cardinality(ids),'undone',false);
end;
$$;

create or replace function public.undo_transaction_metadata(p_event_id uuid,p_expected_version integer)
returns void language plpgsql security definer set search_path = '' as $$
declare event public.correction_events%rowtype; transaction public.transactions%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into event from public.correction_events where id=p_event_id and public.owns_workspace(workspace_id);
  if not found or event.after->>'operation' is distinct from 'metadata' then raise exception 'Metadata correction not found' using errcode = 'P0002'; end if;
  select * into transaction from public.transactions where id=event.transaction_id and workspace_id=event.workspace_id for update;
  if event.undone then return; end if;
  if transaction.version is distinct from p_expected_version or transaction.category_id is distinct from (event.after->>'category_id')::uuid
    or (event.after ? 'merchant_id' and transaction.merchant_id is distinct from (event.after->>'merchant_id')::uuid)
    or to_jsonb(transaction.tags) is distinct from event.after->'tags' or transaction.event_name is distinct from event.after->>'event_name'
    or exists(select 1 from public.correction_events where transaction_id=transaction.id and not undone and (after->>'version')::integer>(event.after->>'version')::integer)
    then raise exception 'Transaction changed; undo latest correction first' using errcode = '40001'; end if;
  update public.transactions set merchant_id=case when event.before ? 'merchant_id' then (event.before->>'merchant_id')::uuid else merchant_id end,
    category_id=(event.before->>'category_id')::uuid,tags=array(select jsonb_array_elements_text(event.before->'tags')),
    event_name=event.before->>'event_name',version=version+1 where id=transaction.id;
  update public.correction_events set undone=true where id=event.id;
end;
$$;


revoke all on function public.bulk_edit_transactions(jsonb,jsonb,uuid),public.undo_transaction_metadata(uuid,integer) from public;
grant execute on function public.bulk_edit_transactions(jsonb,jsonb,uuid),public.undo_transaction_metadata(uuid,integer) to authenticated;

create table public.organization_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  description_key text not null check(char_length(description_key) between 3 and 1000),
  merchant_id uuid references public.merchants(id),
  category_id uuid references public.categories(id),
  approved_by uuid not null references auth.users(id),
  enabled boolean not null default true,
  version integer not null default 1 check(version>0),
  updated_at timestamptz not null default now(),
  unique(workspace_id,description_key),
  check(merchant_id is not null or category_id is not null)
);
alter table public.organization_rules enable row level security;
create policy organization_rules_owned on public.organization_rules for select using(public.owns_workspace(workspace_id));
revoke all on public.organization_rules from anon,authenticated;
grant select on public.organization_rules to authenticated,service_role;

create function public.save_organization_rule(p_workspace uuid,p_key text,p_merchant uuid,p_category uuid,p_enabled boolean,p_expected_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare existing public.organization_rules%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if not public.owns_workspace(p_workspace) then raise exception 'Workspace not found' using errcode='P0002'; end if;
  if p_key is null or p_key<>btrim(p_key) or char_length(p_key) not between 3 and 1000
    or p_enabled is null or p_expected_version is null or p_expected_version<0 or (p_merchant is null and p_category is null)
    then raise exception 'Choose an approved description and organization target' using errcode='22023'; end if;
  if (p_merchant is not null and not exists(select 1 from public.merchants where id=p_merchant and workspace_id=p_workspace))
    or (p_category is not null and not exists(select 1 from public.categories where id=p_category and workspace_id=p_workspace))
    then raise exception 'Organization target not found' using errcode='P0002'; end if;
  -- Serialize creation and updates of the same owned description rule.
  perform pg_advisory_xact_lock(hashtextextended(p_workspace::text||':organization-rule:'||p_key,0));
  select * into existing from public.organization_rules where workspace_id=p_workspace and description_key=p_key for update;
  if found then
    if existing.version<>p_expected_version then raise exception 'Rule changed; reload its current version' using errcode='40001'; end if;
    update public.organization_rules set merchant_id=p_merchant,category_id=p_category,enabled=p_enabled,
      approved_by=auth.uid(),version=version+1,updated_at=now() where id=existing.id returning * into existing;
  else
    if p_expected_version<>0 then raise exception 'Rule changed; reload its current version' using errcode='40001'; end if;
    insert into public.organization_rules(workspace_id,description_key,merchant_id,category_id,approved_by,enabled)
      values(p_workspace,p_key,p_merchant,p_category,auth.uid(),p_enabled) returning * into existing;
  end if;
  return jsonb_build_object('id',existing.id,'version',existing.version);
end;
$$;
revoke all on function public.save_organization_rule(uuid,text,uuid,uuid,boolean,integer) from public;
grant execute on function public.save_organization_rule(uuid,text,uuid,uuid,boolean,integer) to authenticated;
