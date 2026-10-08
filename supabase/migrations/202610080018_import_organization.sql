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
  if exists(select 1 from public.organization_reviews r join public.transaction_batches b on b.id=r.batch_id
    where r.workspace_id=event.workspace_id and r.batch_id::text=event.after->>'batch_id' and not b.undone)
    then raise exception 'Undo this organization through its complete batch review' using errcode='22023'; end if;
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

create table public.organization_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id uuid not null references auth.users(id),
  request_id uuid not null,
  selection jsonb not null,
  snapshots jsonb not null,
  patch jsonb not null,
  merchant_name text check(char_length(merchant_name) between 1 and 100),
  rule_key text check(char_length(rule_key) between 3 and 1000),
  rule_version integer not null default 0 check(rule_version>=0),
  evidence jsonb not null,
  status text not null default 'pending' check(status in ('pending','applied','dismissed')),
  batch_id uuid references public.transaction_batches(id),
  saved_rule_id uuid references public.organization_rules(id),
  saved_rule_before jsonb,
  saved_rule_after jsonb,
  created_at timestamptz not null default now(),
  unique(workspace_id,request_id),
  check(jsonb_typeof(selection)='array' and jsonb_array_length(selection) between 1 and 50),
  check(jsonb_typeof(snapshots)='array' and jsonb_array_length(snapshots)=jsonb_array_length(selection)),
  check(jsonb_typeof(patch)='object' and patch-array['merchant_id','category_id']='{}'::jsonb),
  check(jsonb_typeof(evidence)='array' and jsonb_array_length(evidence)<=2000),
  check((status='applied')=(batch_id is not null))
);
alter table public.organization_reviews enable row level security;
create policy organization_reviews_owned on public.organization_reviews for select using(public.owns_workspace(workspace_id));
revoke all on public.organization_reviews from anon,authenticated;
grant select on public.organization_reviews to authenticated,service_role;

create function public.create_organization_review(p_rows jsonb,p_patch jsonb,p_merchant_name text,p_rule_key text,p_evidence jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare transaction public.transactions%rowtype; workspace uuid; ids uuid[]; row jsonb; snapshots jsonb; review public.organization_reviews%rowtype; rule_version integer;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_request_id is null or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 50
    or p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch-array['merchant_id','category_id']<>'{}'::jsonb
    or (p_patch='{}'::jsonb and p_merchant_name is null) or (p_merchant_name is not null and (char_length(btrim(p_merchant_name)) not between 1 and 100 or p_patch ? 'merchant_id'))
    or (p_rule_key is not null and char_length(p_rule_key) not between 3 and 1000)
    or p_evidence is null or jsonb_typeof(p_evidence)<>'array' or jsonb_array_length(p_evidence)>2000
    then raise exception 'Invalid bounded organization review' using errcode='22023'; end if;
  for row in select value from jsonb_array_elements(p_rows||p_evidence) loop
    if jsonb_typeof(row)<>'object' or row-array['id','version']<>'{}'::jsonb or jsonb_typeof(row->'id') is distinct from 'string'
      or jsonb_typeof(row->'version') is distinct from 'number' or row->>'version' !~ '^[0-9]+$'
      then raise exception 'Review requires IDs and integer versions' using errcode='22023'; end if;
  end loop;
  select array_agg((value->>'id')::uuid) into ids from jsonb_array_elements(p_rows);
  if cardinality(ids)<>(select count(distinct id) from unnest(ids) id) then raise exception 'Duplicate review selection' using errcode='22023'; end if;
  p_rows:=(select jsonb_agg(value order by value->>'id') from jsonb_array_elements(p_rows));
  for transaction in select * from public.transactions where id=any(ids) and public.owns_workspace(workspace_id) order by id for update loop
    if workspace is not null and transaction.workspace_id<>workspace then raise exception 'Review must share a workspace' using errcode='22023'; end if;
    workspace:=transaction.workspace_id;
  end loop;
  if workspace is null or (select count(*) from public.transactions where id=any(ids) and workspace_id=workspace)<>cardinality(ids)
    then raise exception 'Review selection not found' using errcode='P0002'; end if;
  if (p_patch ? 'merchant_id' and p_patch->'merchant_id'<>'null'::jsonb and not exists(select 1 from public.merchants where id=(p_patch->>'merchant_id')::uuid and workspace_id=workspace))
    or (p_patch ? 'category_id' and p_patch->'category_id'<>'null'::jsonb and not exists(select 1 from public.categories where id=(p_patch->>'category_id')::uuid and workspace_id=workspace))
    then raise exception 'Organization target not found' using errcode='P0002'; end if;
  select * into review from public.organization_reviews where workspace_id=workspace and request_id=p_request_id;
  if found then
    if review.selection<>p_rows or review.patch<>p_patch or review.merchant_name is distinct from nullif(btrim(p_merchant_name),'')
      or review.rule_key is distinct from p_rule_key or review.evidence<>p_evidence then raise exception 'Review request reused for another change' using errcode='22023'; end if;
    return jsonb_build_object('id',review.id);
  end if;
  if exists(select 1 from jsonb_array_elements(p_rows) selected join public.transactions t on t.id=(selected->>'id')::uuid where t.version<>(selected->>'version')::integer or t.status='voided')
    or exists(select 1 from jsonb_array_elements(p_evidence) selected left join public.transactions t on t.id=(selected->>'id')::uuid and t.workspace_id=workspace where t.id is null or t.version<>(selected->>'version')::integer)
    then raise exception 'Review history changed; reload suggestions' using errcode='40001'; end if;
  select jsonb_agg(jsonb_build_object('id',id,'version',version,'description',description,'posted_on',posted_on,'amount_minor',amount_minor::text,
    'currency_code',currency_code,'merchant_id',merchant_id,'category_id',category_id,'kind',kind,'review_reasons',review_reasons) order by id) into snapshots
    from public.transactions where id=any(ids) and workspace_id=workspace;
  select version into rule_version from public.organization_rules where workspace_id=workspace and description_key=p_rule_key;
  insert into public.organization_reviews(workspace_id,actor_id,request_id,selection,snapshots,patch,merchant_name,rule_key,rule_version,evidence)
    values(workspace,auth.uid(),p_request_id,p_rows,snapshots,p_patch,nullif(btrim(p_merchant_name),''),p_rule_key,coalesce(rule_version,0),p_evidence) returning * into review;
  return jsonb_build_object('id',review.id);
end;
$$;

create function public.apply_organization_review(p_review_id uuid,p_save_rule boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare review public.organization_reviews%rowtype; patch jsonb; merchant uuid; result jsonb; rule uuid; rule_before jsonb; rule_after jsonb; batch_undone boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_save_rule is null then raise exception 'Choose whether to save an approved rule' using errcode='22023'; end if;
  select * into review from public.organization_reviews where id=p_review_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Review not found' using errcode='P0002'; end if;
  -- Match the existing metadata batch lock order before locking this review.
  perform id from public.transactions where workspace_id=review.workspace_id and id in(select (value->>'id')::uuid from jsonb_array_elements(review.selection)) order by id for update;
  select * into review from public.organization_reviews where id=p_review_id for update;
  if review.status='applied' then
    if p_save_rule<>(review.saved_rule_id is not null) then raise exception 'Approval retry changed rule intent' using errcode='22023'; end if;
    select undone into strict batch_undone from public.transaction_batches where id=review.batch_id and workspace_id=review.workspace_id;
    return jsonb_build_object('batchId',review.batch_id,'count',jsonb_array_length(review.selection),'undone',batch_undone);
  end if;
  if review.status<>'pending' or (p_save_rule and review.rule_key is null) then raise exception 'Review is not available for this approval' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(review.evidence) selected left join public.transactions t on t.id=(selected->>'id')::uuid and t.workspace_id=review.workspace_id where t.id is null or t.version<>(selected->>'version')::integer)
    then raise exception 'Suggestion evidence changed; create a new review' using errcode='40001'; end if;
  patch:=review.patch;
  if review.merchant_name is not null then
    insert into public.merchants(workspace_id,name,normalized_name) values(review.workspace_id,review.merchant_name,lower(regexp_replace(review.merchant_name,'\s+',' ','g')))
      on conflict(workspace_id,normalized_name) do nothing;
    select id into strict merchant from public.merchants where workspace_id=review.workspace_id and normalized_name=lower(regexp_replace(review.merchant_name,'\s+',' ','g'));
    patch:=patch||jsonb_build_object('merchant_id',merchant);
  end if;
  result:=public.bulk_edit_transactions(review.selection,patch,review.request_id);
  if p_save_rule then
    select to_jsonb(r) into rule_before from public.organization_rules r where workspace_id=review.workspace_id and description_key=review.rule_key;
    rule:=(public.save_organization_rule(review.workspace_id,review.rule_key,(patch->>'merchant_id')::uuid,(patch->>'category_id')::uuid,true,review.rule_version)->>'id')::uuid;
    select to_jsonb(r) into strict rule_after from public.organization_rules r where id=rule and workspace_id=review.workspace_id;
  end if;
  update public.organization_reviews set status='applied',batch_id=(result->>'batchId')::uuid,saved_rule_id=rule,saved_rule_before=rule_before,saved_rule_after=rule_after where id=review.id;
  return result;
end;
$$;

create function public.dismiss_organization_review(p_review_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  update public.organization_reviews set status='dismissed' where id=p_review_id and public.owns_workspace(workspace_id) and status in ('pending','dismissed');
  if not found then raise exception 'Pending review not found' using errcode='P0002'; end if;
end;
$$;
revoke all on function public.create_organization_review(jsonb,jsonb,text,text,jsonb,uuid),public.apply_organization_review(uuid,boolean),public.dismiss_organization_review(uuid) from public;
grant execute on function public.create_organization_review(jsonb,jsonb,text,text,jsonb,uuid),public.apply_organization_review(uuid,boolean),public.dismiss_organization_review(uuid) to authenticated;

-- Organization approval and its saved-rule intent share the existing atomic batch Undo.
create or replace function public.undo_transaction_batch(p_batch_id uuid,p_rows jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare batch public.transaction_batches%rowtype; target jsonb; event public.correction_events%rowtype; ids uuid[]; review public.organization_reviews%rowtype; current_rule jsonb;
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
  select * into review from public.organization_reviews where batch_id=batch.id and workspace_id=batch.workspace_id for update;
  if found and review.saved_rule_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(batch.workspace_id::text||':organization-rule:'||review.rule_key,0));
    select to_jsonb(r) into current_rule from public.organization_rules r where id=review.saved_rule_id and workspace_id=batch.workspace_id for update;
    if current_rule is distinct from review.saved_rule_after then raise exception 'Approved rule changed; undo its latest edit first' using errcode='40001'; end if;
  end if;
  -- Only this locked atomic operation can permit individual event restoration.
  -- Failures below roll this marker, every metadata write and the rule back together.
  update public.transaction_batches set undone=true where id=batch.id;
  for target in select value from jsonb_array_elements(p_rows) order by value->>'id' loop
    select * into event from public.correction_events where transaction_id=(target->>'id')::uuid and workspace_id=batch.workspace_id and after->>'batch_id'=batch.id::text;
    if not found then raise exception 'Batch correction missing' using errcode = 'P0002'; end if;
    perform public.undo_transaction_metadata(event.id,(target->>'version')::integer);
  end loop;
  if review.saved_rule_id is not null then
    if review.saved_rule_before is null then
      update public.organization_rules set enabled=false,version=version+1,updated_at=now() where id=review.saved_rule_id;
    else
      update public.organization_rules set merchant_id=(review.saved_rule_before->>'merchant_id')::uuid,
        category_id=(review.saved_rule_before->>'category_id')::uuid,enabled=(review.saved_rule_before->>'enabled')::boolean,
        approved_by=(review.saved_rule_before->>'approved_by')::uuid,version=version+1,updated_at=now() where id=review.saved_rule_id;
    end if;
  end if;

end;
$$;
