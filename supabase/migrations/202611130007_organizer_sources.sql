-- The organizer also writes labels that are not AI guesses: the owner's rules, the owner's confirmed memory and the
-- bank's own codes. They go through the same audited path (organizer_ops, Undo, suppression) with their own
-- provenance: `source` is 'rule', 'memory' or 'system' ('ai' when left out), and only AI labels carry a confidence.
-- Rows organized from the owner's memory are never relabelled, like the owner's own rows.
create or replace function public.apply_ai_organization(p_workspace uuid,p_run uuid,p_items jsonb,p_proposal uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  item jsonb; t public.transactions%rowtype; ids uuid[]; new_category uuid; new_merchant uuid; merchant_name text; normalized text;
  create_merchant boolean; was_suppressed boolean; op uuid; reason text; applied uuid[]:='{}'; skipped jsonb:='{}';
begin
  if p_workspace is null or not exists(select 1 from public.workspaces where id=p_workspace) then raise exception 'Workspace not found' using errcode='P0002'; end if;
  if p_run is not null and not exists(select 1 from public.agent_runs where id=p_run and workspace_id=p_workspace) then raise exception 'Run not found' using errcode='P0002'; end if;
  if p_proposal is not null and not exists(select 1 from public.agent_proposals where id=p_proposal and workspace_id=p_workspace) then raise exception 'Proposal not found' using errcode='P0002'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 500 then raise exception 'Invalid AI organization' using errcode='22023'; end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item)<>'object' or item-array['transaction_id','expected_version','category_id','merchant_id','merchant_name','confidence','reason','identity_key','source']<>'{}'::jsonb
      or coalesce(item->>'source','ai') not in ('ai','rule','memory','system')
      or jsonb_typeof(item->'transaction_id') is distinct from 'string' or coalesce(item->>'expected_version','') !~ '^[0-9]+$'
      or coalesce(item->>'confidence','') not in ('high','medium','low')
      or jsonb_typeof(item->'identity_key') is distinct from 'string' or char_length(item->>'identity_key')>1000
      or coalesce(jsonb_typeof(item->'reason'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(item->'category_id'),'null') not in ('string','null') or coalesce(jsonb_typeof(item->'merchant_id'),'null') not in ('string','null')
      or coalesce(jsonb_typeof(item->'merchant_name'),'null') not in ('string','null')
      or (item->>'merchant_name' is not null and (char_length(btrim(item->>'merchant_name')) not between 1 and 100 or item->>'merchant_id' is not null))
      or coalesce(item->>'category_id',item->>'merchant_id',item->>'merchant_name') is null
      then raise exception 'Invalid AI organization item' using errcode='22023'; end if;
  end loop;
  select array_agg((value->>'transaction_id')::uuid) into ids from jsonb_array_elements(p_items);
  if cardinality(ids)<>(select count(distinct id) from unnest(ids) id) then raise exception 'Duplicate AI organization row' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) i where (i->>'category_id' is not null and not exists(select 1 from public.categories c where c.id=(i->>'category_id')::uuid and c.workspace_id=p_workspace))
    or (i->>'merchant_id' is not null and not exists(select 1 from public.merchants m where m.id=(i->>'merchant_id')::uuid and m.workspace_id=p_workspace)))
    then raise exception 'Organization target not found' using errcode='P0002'; end if;
  -- Same lock order as the owner's bulk edits.
  perform 1 from public.transactions where id=any(ids) and workspace_id=p_workspace order by id for update;
  for item in select value from jsonb_array_elements(p_items) order by value->>'transaction_id' loop
    select * into t from public.transactions where id=(item->>'transaction_id')::uuid and workspace_id=p_workspace;
    reason := null;
    if not found then reason := 'missing';
    elsif item->>'confidence'='low' then reason := 'low_confidence';
    elsif t.version<>(item->>'expected_version')::integer then reason := 'changed';
    elsif t.organized_by='owner' then reason := 'owner';
    elsif t.organized_by='memory' then reason := 'memory';
    elsif exists(select 1 from public.correction_events e where e.transaction_id=t.id and e.workspace_id=p_workspace and not e.undone and e.origin='owner'
      and ((e.before ? 'category_id' and e.after ? 'category_id' and e.before->'category_id' is distinct from e.after->'category_id')
        or (e.before ? 'merchant_id' and e.after ? 'merchant_id' and e.before->'merchant_id' is distinct from e.after->'merchant_id'))) then reason := 'owner_corrected';
    elsif exists(select 1 from public.transaction_split_sets s where s.transaction_id=t.id and s.undone_at is null) then reason := 'split';
    end if;
    if reason is null then
      new_category := case when t.category_id is null then (item->>'category_id')::uuid end;
      new_merchant := null; create_merchant := false; was_suppressed := false; merchant_name := null;
      if t.merchant_id is null and item->>'merchant_id' is not null then new_merchant := (item->>'merchant_id')::uuid;
      elsif t.merchant_id is null and item->>'merchant_name' is not null then
        merchant_name := btrim(item->>'merchant_name'); normalized := lower(regexp_replace(merchant_name,'\s+',' ','g'));
        select id into new_merchant from public.merchants where workspace_id=p_workspace and normalized_name=normalized;
        create_merchant := new_merchant is null;
      end if;
      if new_category is not null and exists(select 1 from public.organizer_ops o where o.workspace_id=p_workspace and o.suppressed
        and o.identity_key=item->>'identity_key' and o.category_id=new_category) then new_category := null; was_suppressed := true; end if;
      if new_merchant is not null and exists(select 1 from public.organizer_ops o where o.workspace_id=p_workspace and o.suppressed
        and o.identity_key=item->>'identity_key' and o.merchant_id=new_merchant) then new_merchant := null; was_suppressed := true; end if;
      if new_category is null and new_merchant is null and not create_merchant then reason := case when was_suppressed then 'suppressed' else 'labelled' end; end if;
    end if;
    if reason is not null then
      skipped := jsonb_set(skipped,array[reason],to_jsonb(coalesce((skipped->>reason)::integer,0)+1));
      continue;
    end if;
    if create_merchant then
      insert into public.merchants(workspace_id,name,normalized_name,created_by) values(p_workspace,merchant_name,normalized,'ai') on conflict(workspace_id,normalized_name) do nothing;
      select id into strict new_merchant from public.merchants where workspace_id=p_workspace and normalized_name=normalized;
    end if;
    insert into public.organizer_ops(workspace_id,run_id,proposal_id,transaction_id,identity_key,category_id,merchant_id,before,after)
      values(p_workspace,p_run,p_proposal,t.id,item->>'identity_key',new_category,new_merchant,
        jsonb_build_object('category_id',t.category_id,'merchant_id',t.merchant_id,'organized_by',t.organized_by,'ai_confidence',t.ai_confidence,
          'ai_reason',t.ai_reason,'organize_op_id',t.organize_op_id,'version',t.version),'{}') returning id into op;
    update public.transactions set category_id=coalesce(new_category,category_id),merchant_id=coalesce(new_merchant,merchant_id),
      organized_by=coalesce(item->>'source','ai'),ai_confidence=case when coalesce(item->>'source','ai')='ai' then item->>'confidence' end,ai_reason=left(nullif(btrim(item->>'reason'),''),500),organize_op_id=op,version=version+1
      where id=t.id returning * into t;
    update public.organizer_ops set after=jsonb_build_object('category_id',t.category_id,'merchant_id',t.merchant_id,'organized_by',t.organized_by,
      'ai_confidence',t.ai_confidence,'ai_reason',t.ai_reason,'organize_op_id',t.organize_op_id,'version',t.version) where id=op;
    applied := applied||t.id;
  end loop;
  return jsonb_build_object('applied',cardinality(applied),'transactionIds',to_jsonb(applied),'skipped',skipped);
end;
$$;
revoke all on function public.apply_ai_organization(uuid,uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.apply_ai_organization(uuid,uuid,jsonb,uuid) to service_role;
