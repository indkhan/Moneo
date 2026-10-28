-- Recurring schedules get an optional category (e.g. Job, Rent). edit_assumption accepts it,
-- undo restores it, and chat can propose schedule changes as recurring_edit cards.
alter table public.categories add constraint categories_id_workspace_key unique (id, workspace_id);
alter table public.financial_assumptions add column category_id uuid;
alter table public.financial_assumptions add constraint financial_assumptions_category_fkey
  foreign key (category_id, workspace_id) references public.categories(id, workspace_id) on delete set null (category_id);
create index financial_assumptions_category on public.financial_assumptions(category_id) where category_id is not null;

create or replace function public.edit_assumption(p_id uuid, p_expected_version integer, p_patch jsonb, p_request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  row_value public.financial_assumptions%rowtype;
  edited public.financial_assumptions%rowtype;
  existing public.planning_events%rowtype;
  event_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_expected_version is null or p_expected_version < 1 or p_request_id is null or p_patch is null or jsonb_typeof(p_patch) <> 'object'
    or p_patch = '{}'::jsonb or p_patch - array['name','amount_minor','kind','cadence','starts_on','ends_on','enabled','removed','category_id'] <> '{}'::jsonb
    then raise exception 'Invalid assumption edit' using errcode = '22023'; end if;
  if p_patch ? 'name' then
    if jsonb_typeof(p_patch->'name') <> 'string' then raise exception 'Name must be text' using errcode = '22023'; end if;
    p_patch := jsonb_set(p_patch, '{name}', to_jsonb(btrim(p_patch->>'name')));
  end if;
  select * into row_value from public.financial_assumptions where id = p_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Assumption not found' using errcode = 'P0002'; end if;
  select * into existing from public.planning_events where workspace_id = row_value.workspace_id and request_id = p_request_id;
  if found then
    if existing.entity_type <> 'assumption' or existing.entity_id <> p_id or (existing.before->>'version')::integer <> p_expected_version
      or not existing.after @> (p_patch - 'removed') or (p_patch ? 'removed' and existing.after->>'removed_at' is null)
      then raise exception 'Request ID reused for a different edit' using errcode = '22023'; end if;
    return existing.id;
  end if;
  if row_value.version <> p_expected_version then raise exception 'Assumption changed; reload before editing' using errcode = '40001'; end if;
  if row_value.removed_at is not null then raise exception 'Assumption is removed; undo its removal first' using errcode = '22023'; end if;
  if p_patch ? 'removed' and p_patch <> '{"removed":true}'::jsonb then raise exception 'Invalid removal' using errcode = '22023'; end if;
  if p_patch ? 'amount_minor' and (jsonb_typeof(p_patch->'amount_minor') <> 'string' or p_patch->>'amount_minor' !~ '^-?[0-9]+$')
    then raise exception 'Amount must be an exact integer string' using errcode = '22023'; end if;
  if p_patch ? 'enabled' and jsonb_typeof(p_patch->'enabled') <> 'boolean' then raise exception 'Enabled must be boolean' using errcode = '22023'; end if;
  if p_patch ? 'category_id' and p_patch->'category_id' <> 'null'::jsonb and (jsonb_typeof(p_patch->'category_id') <> 'string'
    or not exists(select 1 from public.categories where id::text = p_patch->>'category_id' and workspace_id = row_value.workspace_id))
    then raise exception 'Category not found' using errcode = 'P0002'; end if;
  edited := jsonb_populate_record(row_value, p_patch - 'removed');
  if p_patch ? 'kind' and p_patch->>'kind' is distinct from (case when edited.amount_minor >= 0 then 'income' else 'expense' end)
    then raise exception 'Kind must match the signed amount' using errcode = '22023'; end if;
  if p_patch ? 'starts_on' and (jsonb_typeof(p_patch->'starts_on') <> 'string' or p_patch->>'starts_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
    then raise exception 'Start date must be an ISO calendar date' using errcode = '22023'; end if;
  if p_patch ? 'ends_on' and p_patch->'ends_on' <> 'null'::jsonb and (jsonb_typeof(p_patch->'ends_on') <> 'string' or p_patch->>'ends_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
    then raise exception 'End date must be an ISO calendar date' using errcode = '22023'; end if;
  if edited.name is null or length(btrim(edited.name)) not between 1 and 120 then raise exception 'Invalid assumption name' using errcode = '22023'; end if;
  -- Equivalent form values, toggles, amount/name edits and end boundaries keep
  -- the established calendar. Actual start/cadence changes intentionally reset it.
  if edited.starts_on is distinct from row_value.starts_on or edited.cadence is distinct from row_value.cadence then
    edited.schedule_anchor_on:=edited.starts_on;
  end if;
  -- Retain confirmed fulfillment across provenance-only/toggle edits. Once the
  -- user changes financial scheduling inputs, only explicit settlements apply.
  edited.recurring_evidence_eligible:=(row_value.recurring_evidence_eligible or row_value.source='recurring_confirmed')
    and edited.amount_minor is not distinct from row_value.amount_minor
    and edited.starts_on is not distinct from row_value.starts_on
    and edited.cadence is not distinct from row_value.cadence;
  perform set_config('moneo.planning_request_id', p_request_id::text, true);
  update public.financial_assumptions set name = btrim(edited.name), amount_minor = edited.amount_minor,
    kind = case when edited.amount_minor >= 0 then 'income' else 'expense' end,
    cadence = edited.cadence, starts_on = edited.starts_on, schedule_anchor_on = edited.schedule_anchor_on, ends_on = edited.ends_on,
    source = 'user', confirmed = true, recurring_evidence_eligible = edited.recurring_evidence_eligible, category_id = edited.category_id,
    enabled = case when p_patch ? 'removed' then false else edited.enabled end,
    removed_at = case when p_patch ? 'removed' then now() else null end
  where id = p_id;
  perform set_config('moneo.planning_request_id', '', true);
  select id into strict event_id from public.planning_events where workspace_id = row_value.workspace_id and request_id = p_request_id;
  return event_id;
end;
$$;

create or replace function public.undo_planning_event(p_event_id uuid, p_expected_version integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  event_row public.planning_events%rowtype;
  current_value jsonb;
  assumption public.financial_assumptions%rowtype;
  spending public.spending_plans%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into event_row from public.planning_events where id = p_event_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Planning event not found' using errcode = 'P0002'; end if;
  if event_row.entity_type = 'assumption' then
    select * into assumption from public.financial_assumptions where id = event_row.entity_id and workspace_id = event_row.workspace_id for update;
    current_value := to_jsonb(assumption) || jsonb_build_object('amount_minor', assumption.amount_minor::text);
  else
    select * into spending from public.spending_plans where id = event_row.entity_id and workspace_id = event_row.workspace_id for update;
    current_value := to_jsonb(spending) || jsonb_build_object('limit_minor', spending.limit_minor::text);
    if not event_row.after ? 'rollover' then current_value:=current_value-array['rollover','rollover_from']; end if;
  end if;
  select * into event_row from public.planning_events where id = p_event_id for update;
  if event_row.undone then return; end if;
  -- Pre-017 receipts lack the nullable anchor. Compare their recorded fields only
  -- when the current anchor is still NULL; a later anchor remains a stale change.
  if event_row.entity_type='assumption' and not(event_row.after ? 'schedule_anchor_on') and assumption.schedule_anchor_on is null then
    current_value:=current_value-'schedule_anchor_on';
  end if;
  if event_row.entity_type='assumption' and not(event_row.after ? 'recurring_evidence_eligible') and not assumption.recurring_evidence_eligible then
    current_value:=current_value-'recurring_evidence_eligible';
  end if;
  -- Receipts from before categories lack the key; they still match while no category is set.
  if event_row.entity_type='assumption' and not(event_row.after ? 'category_id') and assumption.category_id is null then
    current_value:=current_value-'category_id';
  end if;
  if p_expected_version is null or (current_value->>'version')::integer is distinct from p_expected_version
    or current_value - array['version','updated_at'] is distinct from event_row.after - array['version','updated_at']
    then raise exception 'Planning record changed; undo latest change first' using errcode = '40001'; end if;
  if exists(select 1 from public.planning_events where workspace_id=event_row.workspace_id and entity_type=event_row.entity_type and entity_id=event_row.entity_id and not undone and (after->>'version')::integer>(event_row.after->>'version')::integer) then raise exception 'Undo newer planning changes first' using errcode='40001'; end if;
  perform set_config('moneo.planning_undo', 'true', true);
  if event_row.entity_type = 'assumption' then
    if event_row.before is null then
      update public.financial_assumptions set enabled = false, removed_at = now(), source = 'user', confirmed = true where id = event_row.entity_id;
    else
      assumption := jsonb_populate_record(null::public.financial_assumptions, event_row.before);
      update public.financial_assumptions set name = assumption.name, amount_minor = assumption.amount_minor, kind = assumption.kind,
        cadence = assumption.cadence, starts_on = assumption.starts_on, schedule_anchor_on = assumption.schedule_anchor_on, ends_on = assumption.ends_on,
        source = assumption.source, confidence = assumption.confidence, confirmed = assumption.confirmed,
        recurring_evidence_eligible = coalesce(assumption.recurring_evidence_eligible,false), category_id = assumption.category_id,
        enabled = assumption.enabled, removed_at = assumption.removed_at where id = event_row.entity_id;
    end if;
  else
    if event_row.before is null then
      delete from public.spending_plans where id = event_row.entity_id;
    else
      spending := jsonb_populate_record(null::public.spending_plans, event_row.before);
      update public.spending_plans set limit_minor = spending.limit_minor, enabled = spending.enabled, rollover = coalesce(spending.rollover,false), rollover_from = coalesce(spending.rollover_from,(select rollover_from from public.spending_plans where id=event_row.entity_id)), updated_at = now() where id = event_row.entity_id;
    end if;
  end if;
  update public.planning_events set undone = true, undone_at = now(), undone_by = auth.uid() where id = p_event_id;
  perform set_config('moneo.planning_undo', 'false', true);
end;
$$;

-- Chat proposes adding, changing, confirming or removing a recurring schedule; accepting runs the same RPCs as the Recurring page.
alter table public.agent_proposals drop constraint agent_proposals_kind_check;
alter table public.agent_proposals add constraint agent_proposals_kind_check check (kind in ('categorize','recurring','budget','finding','iou_create','iou_settle','transaction_create','balance_set','recurring_edit'));
drop policy own_agent_proposals_standalone_insert on public.agent_proposals;
create policy own_agent_proposals_standalone_insert on public.agent_proposals for insert to authenticated
  with check (public.owns_workspace(workspace_id) and run_id is null and kind in ('iou_create','iou_settle','transaction_create','balance_set','recurring_edit') and status = 'proposed');
