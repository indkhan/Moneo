-- AI organization labels get their own provenance. The organizer writes category and merchant labels
-- itself (the one AI write without a card), marked as AI and logged in organizer_ops for Undo. They
-- never become owner corrections or organization rules, so they never count as evidence either.

-- Who set a row's labels: null = not organized yet (or before this migration).
alter table public.transactions add column organized_by text check (organized_by in ('owner','rule','memory','ai','system'));
alter table public.transactions add column ai_confidence text check (ai_confidence in ('high','medium','low'));
alter table public.transactions add column ai_reason text check (char_length(ai_reason) <= 500);
alter table public.transactions add column organize_op_id uuid;

-- Events the old auto-apply left behind are stamped 'ai' so they never count as owner corrections.
alter table public.correction_events add column origin text not null default 'owner' check (origin in ('owner','ai'));

-- Later the AI may change only categories and merchants it made and the owner never used.
alter table public.categories add column created_by text not null default 'owner' check (created_by in ('owner','ai'));
alter table public.categories add column owner_touched boolean not null default false;
alter table public.merchants add column created_by text not null default 'owner' check (created_by in ('owner','ai'));
alter table public.merchants add column owner_touched boolean not null default false;

-- One row per AI label write: the Undo record and, once undone, a "don't suggest this again" marker
-- for (identity_key, category or merchant). identity_key is today's organization description key.
create table public.organizer_ops (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid references public.agent_runs(id) on delete set null,
  proposal_id uuid references public.agent_proposals(id) on delete set null,
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  identity_key text not null check (char_length(identity_key) <= 1000),
  category_id uuid,
  merchant_id uuid,
  before jsonb not null,
  after jsonb not null,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  suppressed boolean not null default false,
  check (category_id is not null or merchant_id is not null)
);
create index organizer_ops_workspace_created on public.organizer_ops(workspace_id, created_at desc);
create index organizer_ops_transaction on public.organizer_ops(transaction_id);
create index organizer_ops_proposal on public.organizer_ops(proposal_id) where proposal_id is not null;
create index organizer_ops_suppressed on public.organizer_ops(workspace_id, identity_key) where suppressed;
alter table public.organizer_ops enable row level security;
create policy organizer_ops_owned on public.organizer_ops for select using (public.owns_workspace(workspace_id));
revoke all on public.organizer_ops from anon, authenticated;
grant select on public.organizer_ops to authenticated, service_role;

-- An owner correction that changes a row's category or merchant makes the owner its organizer. The
-- event keeps the previous provenance in `before`, so undoing the edit restores an AI row exactly.
-- Every owner path (quick edit, chat, bulk edit, organization review) writes such an event.
create function public.stamp_owner_organization() returns trigger language plpgsql security definer set search_path='' as $$
declare current_row public.transactions%rowtype; category_changed boolean; merchant_changed boolean;
begin
  if new.origin<>'owner' then return new; end if;
  category_changed := new.before ? 'category_id' and new.after ? 'category_id' and new.before->'category_id' is distinct from new.after->'category_id';
  merchant_changed := new.before ? 'merchant_id' and new.after ? 'merchant_id' and new.before->'merchant_id' is distinct from new.after->'merchant_id';
  if not (category_changed or merchant_changed) then return new; end if;
  select * into current_row from public.transactions where id=new.transaction_id and workspace_id=new.workspace_id;
  if not found then return new; end if;
  new.before := new.before || jsonb_build_object('organized_by',current_row.organized_by,'ai_confidence',current_row.ai_confidence,
    'ai_reason',current_row.ai_reason,'organize_op_id',current_row.organize_op_id);
  new.after := new.after || jsonb_build_object('organized_by','owner','ai_confidence',null,'ai_reason',null,'organize_op_id',null);
  update public.transactions set organized_by='owner',ai_confidence=null,ai_reason=null,organize_op_id=null where id=current_row.id;
  if category_changed and new.after->>'category_id' is not null then
    update public.categories set owner_touched=true where id=(new.after->>'category_id')::uuid and workspace_id=new.workspace_id and not owner_touched;
  end if;
  if merchant_changed and new.after->>'merchant_id' is not null then
    update public.merchants set owner_touched=true where id=(new.after->>'merchant_id')::uuid and workspace_id=new.workspace_id and not owner_touched;
  end if;
  return new;
end;
$$;
create trigger correction_events_owner_organization before insert on public.correction_events for each row execute function public.stamp_owner_organization();

-- Undoing any correction that recorded provenance puts that provenance back with the labels.
create function public.restore_undone_organization() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.undone and not old.undone and new.before ? 'organized_by' then
    update public.transactions set organized_by=new.before->>'organized_by',ai_confidence=new.before->>'ai_confidence',
      ai_reason=new.before->>'ai_reason',organize_op_id=(new.before->>'organize_op_id')::uuid
      where id=new.transaction_id and workspace_id=new.workspace_id;
  end if;
  return null;
end;
$$;
create trigger correction_events_restore_organization after update of undone on public.correction_events for each row execute function public.restore_undone_organization();

-- Splitting a row into a category is the owner using that category.
create function public.touch_split_category() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.category_id is not null then
    update public.categories set owner_touched=true where id=new.category_id and workspace_id=new.workspace_id and not owner_touched;
  end if;
  return null;
end;
$$;
create trigger transaction_splits_owner_touch after insert on public.transaction_splits for each row execute function public.touch_split_category();
revoke all on function public.stamp_owner_organization(),public.restore_undone_organization(),public.touch_split_category() from public,anon,authenticated;

-- The organizer's write path (service role only). Fills only empty labels, never on rows the owner
-- organized or corrected, split rows, rows changed since the suggestion, or suggestions the owner
-- undid for the same identity. No correction events, no rules, no auth claims.
create function public.apply_ai_organization(p_workspace uuid,p_run uuid,p_items jsonb,p_proposal uuid default null)
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
    if jsonb_typeof(item)<>'object' or item-array['transaction_id','expected_version','category_id','merchant_id','merchant_name','confidence','reason','identity_key']<>'{}'::jsonb
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
      organized_by='ai',ai_confidence=item->>'confidence',ai_reason=left(nullif(btrim(item->>'reason'),''),500),organize_op_id=op,version=version+1
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

-- The owner's Undo for AI labels. A row is restored only while it still holds exactly what that op
-- wrote (an import that bumps the version does not block it; an owner edit does). Undone
-- suggestions are suppressed for the same identity; a different suggestion is still allowed.
create function public.undo_ai_organization(p_op_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare op public.organizer_ops%rowtype; t public.transactions%rowtype; undone integer:=0; skipped integer:=0;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_op_ids is null or cardinality(p_op_ids) not between 1 and 500 then raise exception 'Choose AI changes to undo' using errcode='22023'; end if;
  if (select count(*) from public.organizer_ops where id=any(p_op_ids) and public.owns_workspace(workspace_id))<>(select count(distinct id) from unnest(p_op_ids) id)
    then raise exception 'AI change not found' using errcode='P0002'; end if;
  perform 1 from public.transactions where id in(select transaction_id from public.organizer_ops where id=any(p_op_ids)) order by id for update;
  for op in select * from public.organizer_ops where id=any(p_op_ids) order by transaction_id,created_at desc for update loop
    if op.undone_at is not null then continue; end if;
    select * into t from public.transactions where id=op.transaction_id and workspace_id=op.workspace_id;
    if t.organize_op_id is distinct from op.id or t.category_id is distinct from (op.after->>'category_id')::uuid
      or t.merchant_id is distinct from (op.after->>'merchant_id')::uuid
      or exists(select 1 from public.transaction_split_sets s where s.transaction_id=t.id and s.undone_at is null) then
      skipped := skipped+1; continue;
    end if;
    update public.transactions set category_id=(op.before->>'category_id')::uuid,merchant_id=(op.before->>'merchant_id')::uuid,
      organized_by=op.before->>'organized_by',ai_confidence=op.before->>'ai_confidence',ai_reason=op.before->>'ai_reason',
      organize_op_id=(op.before->>'organize_op_id')::uuid,version=version+1 where id=t.id;
    update public.organizer_ops set undone_at=now(),suppressed=true where id=op.id;
    undone := undone+1;
  end loop;
  return jsonb_build_object('undone',undone,'skipped',skipped);
end;
$$;
revoke all on function public.undo_ai_organization(uuid[]) from public,anon;
grant execute on function public.undo_ai_organization(uuid[]) to authenticated;

-- The old path stored AI guesses as the owner's corrections and rules.
drop function public.auto_apply_organization_review(uuid,jsonb,jsonb,text,text,jsonb,uuid);

-- Takes back what the old auto-apply did, row by row, keeping anything the owner changed since:
-- * a row is restored (and its event undone) unless a later correction is still active, its labels
--   no longer match the event's `after`, or it was split; an event left in place is stamped 'ai';
-- * a saved rule still exactly as the review left it is deleted (new) or restored (existing);
--   a rule the owner edited since is kept;
-- * merchants those reviews created and nothing uses any more are deleted, the rest marked 'ai';
-- * the proposals are rejected with {reset: true}; the hourly backlog check reorganizes the rows.
create function public.reset_auto_organization() returns jsonb language plpgsql security definer set search_path='' as $$
declare
  review public.organization_reviews%rowtype; event public.correction_events%rowtype; t public.transactions%rowtype; current_rule public.organization_rules%rowtype;
  proposals uuid[]; touched_rules uuid[]:='{}'; merchant_ids uuid[]:='{}'; merchant uuid;
  restored integer:=0; kept integer:=0; rules_deleted integer:=0; rules_restored integer:=0; rules_kept integer:=0; merchants_deleted integer:=0;
begin
  select coalesce(array_agg(p.id),'{}') into proposals from public.agent_proposals p where p.kind='categorize'
    and (p.result->>'auto'='true' or (p.status in ('applying','failed') and exists(select 1 from public.organization_reviews r where r.workspace_id=p.workspace_id and r.request_id=p.id)));
  -- Newest first, so a review that built on an earlier one is taken back before it.
  for review in select r.* from public.organization_reviews r join public.agent_proposals p on p.id=r.request_id and p.workspace_id=r.workspace_id
    where p.id=any(proposals) and r.batch_id is not null order by r.created_at desc,r.id desc for update of r loop
    for event in select * from public.correction_events where workspace_id=review.workspace_id and after->>'batch_id'=review.batch_id::text
      and after->>'operation'='metadata' and not undone order by transaction_id for update loop
      select * into t from public.transactions where id=event.transaction_id and workspace_id=event.workspace_id for update;
      if exists(select 1 from public.correction_events later where later.transaction_id=event.transaction_id and later.id<>event.id and not later.undone
          and (later.after->>'version')::integer>(event.after->>'version')::integer)
        or t.category_id is distinct from (event.after->>'category_id')::uuid
        or (event.after ? 'merchant_id' and t.merchant_id is distinct from (event.after->>'merchant_id')::uuid)
        or exists(select 1 from public.transaction_split_sets s where s.transaction_id=t.id and s.undone_at is null) then
        update public.correction_events set origin='ai' where id=event.id;
        kept := kept+1;
      else
        update public.transactions set category_id=(event.before->>'category_id')::uuid,
          merchant_id=case when event.before ? 'merchant_id' then (event.before->>'merchant_id')::uuid else merchant_id end,version=version+1 where id=t.id;
        update public.correction_events set undone=true where id=event.id;
        restored := restored+1;
      end if;
    end loop;
    update public.transaction_batches set undone=true where id=review.batch_id;
    if review.saved_rule_id is not null and review.saved_rule_after is not null then
      select * into current_rule from public.organization_rules where id=review.saved_rule_id for update;
      if found and (current_rule.version=(review.saved_rule_after->>'version')::integer or current_rule.id=any(touched_rules))
        and (current_rule.merchant_id,current_rule.category_id,current_rule.enabled) is not distinct from
          ((review.saved_rule_after->>'merchant_id')::uuid,(review.saved_rule_after->>'category_id')::uuid,(review.saved_rule_after->>'enabled')::boolean) then
        if review.saved_rule_before is null then
          update public.organization_reviews set saved_rule_id=null where saved_rule_id=current_rule.id;
          delete from public.organization_rules where id=current_rule.id;
          rules_deleted := rules_deleted+1;
        else
          update public.organization_rules set merchant_id=(review.saved_rule_before->>'merchant_id')::uuid,category_id=(review.saved_rule_before->>'category_id')::uuid,
            enabled=(review.saved_rule_before->>'enabled')::boolean,approved_by=(review.saved_rule_before->>'approved_by')::uuid,version=version+1,updated_at=now() where id=current_rule.id;
          touched_rules := touched_rules||current_rule.id;
          rules_restored := rules_restored+1;
        end if;
      elsif found then rules_kept := rules_kept+1;
      end if;
    end if;
    if review.merchant_name is not null then
      merchant_ids := merchant_ids||coalesce((select array_agg(m.id) from public.merchants m where m.workspace_id=review.workspace_id
        and m.normalized_name=lower(regexp_replace(review.merchant_name,'\s+',' ','g')) and m.created_at>=review.created_at),'{}');
    end if;
  end loop;
  foreach merchant in array merchant_ids loop
    if exists(select 1 from public.transactions where merchant_id=merchant) or exists(select 1 from public.organization_rules where merchant_id=merchant) then
      update public.merchants set created_by='ai' where id=merchant;
      continue;
    end if;
    begin
      delete from public.merchants where id=merchant;
      merchants_deleted := merchants_deleted+(case when found then 1 else 0 end);
    exception when foreign_key_violation then
      update public.merchants set created_by='ai' where id=merchant;
    end;
  end loop;
  update public.agent_proposals set status='rejected',result=jsonb_build_object('reset',true),decided_at=coalesce(decided_at,now()) where id=any(proposals);
  return jsonb_build_object('proposals',cardinality(proposals),'restored',restored,'kept',kept,'rulesDeleted',rules_deleted,
    'rulesRestored',rules_restored,'rulesKept',rules_kept,'merchantsDeleted',merchants_deleted);
end;
$$;
revoke all on function public.reset_auto_organization() from public,anon,authenticated;
select public.reset_auto_organization();
