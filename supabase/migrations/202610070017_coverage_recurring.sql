-- MNE014: owned recurring runs, calendar cadence and reversible source propagation.
-- Additive migration only; existing history/version/invalidation triggers remain active.
alter table public.financial_assumptions add column schedule_anchor_on date;
alter table public.financial_assumptions drop constraint financial_assumptions_cadence_check;
alter table public.financial_assumptions add constraint financial_assumptions_cadence_check check(cadence in ('once','daily','weekly','biweekly','monthly','quarterly','yearly'));
alter table public.scenario_overrides drop constraint scenario_overrides_cadence_check;
alter table public.scenario_overrides add constraint scenario_overrides_cadence_check check(cadence in ('once','daily','weekly','biweekly','monthly','quarterly','yearly'));
alter table public.recurring_series drop constraint recurring_series_cadence_check;
alter table public.recurring_series add constraint recurring_series_cadence_check check(cadence in ('weekly','biweekly','monthly','quarterly','yearly'));
alter table public.recurring_series add column run_anchor_id uuid;
alter table public.recurring_series add column merchant_identity text;
-- The existing unique normalized-label key now stores run:<owned anchor UUID> for new decisions.
-- Preserve legacy keys/history, including preexisting overlapping evidence; review rejects ambiguity.

create function public.recurring_merchant_identity(p public.transactions) returns text language sql immutable set search_path='' as $$
 select case when p.merchant_id is not null then 'merchant:'||p.merchant_id::text else 'description:'||btrim(regexp_replace(regexp_replace(lower(p.description),'\m(invoice|reference|ref)[[:space:]:#-]+[a-z0-9-]+\M',' ','g'),'\s+',' ','g')) end
$$;
create function public.recurring_scheduled_date(p_anchor date,p_cadence text,p_index integer) returns date language sql immutable set search_path='' as $$
 select case p_cadence when 'weekly' then p_anchor+7*p_index when 'biweekly' then p_anchor+14*p_index
   when 'monthly' then (p_anchor+make_interval(months=>p_index))::date
   when 'quarterly' then (p_anchor+make_interval(months=>3*p_index))::date
   when 'yearly' then (p_anchor+make_interval(months=>12*p_index))::date end
$$;
create function public.recurring_period_index(p_anchor date,p_cadence text,p_observed date) returns integer language plpgsql immutable set search_path='' as $$
declare step integer; approximate integer; candidate integer; best integer; difference integer; closest integer:=2147483647; tolerance integer;
begin
  if p_anchor is null or p_observed<p_anchor then return null; end if;
  tolerance:=case p_cadence when 'weekly' then 2 when 'biweekly' then 2 when 'monthly' then 4 when 'quarterly' then 4 when 'yearly' then 7 end;
  if tolerance is null then return null; end if;
  if p_cadence in ('weekly','biweekly') then
    step:=case p_cadence when 'weekly' then 7 else 14 end;
    approximate:=floor((p_observed-p_anchor)::numeric/step+0.5)::integer;
  else
    step:=case p_cadence when 'monthly' then 1 when 'quarterly' then 3 else 12 end;
    approximate:=((extract(year from p_observed)::integer-extract(year from p_anchor)::integer)*12+extract(month from p_observed)::integer-extract(month from p_anchor)::integer)/step;
  end if;
  for candidate in greatest(0,approximate-1)..approximate+1 loop
    difference:=abs(p_observed-public.recurring_scheduled_date(p_anchor,p_cadence,candidate));
    if difference<closest then closest:=difference; best:=candidate; end if;
  end loop;
  return case when closest<=tolerance then best end;
end;
$$;

-- Merchant changes must use the SAME existing source invalidation/Undo path.
create or replace function public.recurring_evidence_snapshot(p public.transactions) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',p.id,'account_id',p.account_id,'posted_on',p.posted_on,'description',p.description,'amount_minor',p.amount_minor::text,'currency_code',p.currency_code,'status',p.status,'kind',p.kind,'review_reasons',p.review_reasons,'merchant_id',p.merchant_id)
$$;
update public.recurring_series s set run_anchor_id=(select t.id from public.recurring_series_transactions e join public.transactions t on t.id=e.transaction_id and t.workspace_id=e.workspace_id where e.series_id=s.id order by t.posted_on,t.id limit 1);
update public.recurring_series s set merchant_identity=public.recurring_merchant_identity(t) from public.transactions t where t.id=s.run_anchor_id and t.workspace_id=s.workspace_id;
-- Existing starts_on dates remain intentional scheduling inputs. Do not reinterpret old confirmations.

create function public.review_recurring_series(p_decision text,p_account_id uuid,p_label text,p_cadence text,p_currency_code text,p_evidence jsonb,p_run_anchor_id uuid,p_evidence_limited boolean default false)
returns public.recurring_series language plpgsql security definer set search_path='' as $$
declare a public.accounts%rowtype; t public.transactions%rowtype; s public.recurring_series%rowtype; obligation public.financial_assumptions%rowtype;
  ids uuid[]; item jsonb; identity text; anchor date; first_id uuid; n integer; previous integer:=-1; latest_index integer;
  count_evidence integer; low bigint; high bigint; latest_amount bigint; amount_sign integer; related uuid[]; normalized text; clean text:=btrim(p_label);
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_decision is null or p_decision not in ('confirmed','dismissed') or p_cadence is null or p_cadence not in ('weekly','biweekly','monthly','quarterly','yearly')
    or clean is null or length(clean) not between 1 and 200 or p_currency_code is null or p_currency_code!~'^[A-Z]{3}$' or p_evidence_limited is null then raise exception 'Invalid recurring decision' using errcode='22023'; end if;
  -- Ownership check before trusting client evidence. The lock is taken after posting locks,
  -- matching correction -> series -> assumption lock order, and serializing decisions per account.
  select * into a from public.accounts where id=p_account_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Account not found' using errcode='P0002'; end if;
  if a.currency_code<>p_currency_code then raise exception 'Account currency changed' using errcode='22023'; end if;
  if p_evidence is null or jsonb_typeof(p_evidence)<>'array' then raise exception 'Invalid source evidence' using errcode='22023'; end if;
  count_evidence:=jsonb_array_length(p_evidence);
  if count_evidence not between 3 and 1000 or (p_evidence_limited and count_evidence<>1000) then raise exception 'Evidence must list 3 to 1000 sources' using errcode='22023'; end if;
  for item in select value from jsonb_array_elements(p_evidence) loop
    if jsonb_typeof(item)<>'object' or not(item ?& array['id','version','account_id','posted_on','description','amount_minor','currency_code','status','kind','review_reasons','merchant_id'])
      or item-array['id','version','account_id','posted_on','description','amount_minor','currency_code','status','kind','review_reasons','merchant_id']<>'{}'::jsonb
      or item->>'id'!~'^[0-9a-fA-F-]{36}$' or item->>'version'!~'^[0-9]+$' then raise exception 'Invalid source receipt' using errcode='22023'; end if;
  end loop;
  select array_agg((value->>'id')::uuid) into ids from jsonb_array_elements(p_evidence);
  if (select count(distinct id) from unnest(ids) id)<>count_evidence or p_run_anchor_id is null or not(p_run_anchor_id=any(ids)) then raise exception 'Duplicate sources or missing anchor' using errcode='22023'; end if;
  -- Lock ALL selected sources in UUID order before inspecting evidence or touching schedules.
  perform id from public.transactions where id=any(ids) and workspace_id=a.workspace_id and account_id=a.id order by id for update;
  select * into a from public.accounts where id=p_account_id and public.owns_workspace(workspace_id) for update;
  if not found or a.currency_code<>p_currency_code then raise exception 'Account changed' using errcode='40001'; end if;
  if (select count(*) from public.transactions where id=any(ids) and workspace_id=a.workspace_id and account_id=a.id)<>count_evidence then raise exception 'Evidence not found' using errcode='P0002'; end if;
  for t in select * from public.transactions where id=any(ids) and workspace_id=a.workspace_id and account_id=a.id order by posted_on,id loop
    select value into item from jsonb_array_elements(p_evidence) where value->>'id'=t.id::text;
    if item is distinct from public.recurring_evidence_snapshot(t)||jsonb_build_object('version',t.version) then raise exception 'Source changed; reload before deciding' using errcode='40001'; end if;
    if t.status<>'posted' or t.kind<>'ordinary' or cardinality(t.review_reasons)<>0 or t.currency_code<>p_currency_code or t.amount_minor=0 then raise exception 'Source not eligible' using errcode='22023'; end if;
    if t.merchant_id is not null and not exists(select 1 from public.merchants where id=t.merchant_id and workspace_id=a.workspace_id) then raise exception 'Merchant not owned' using errcode='P0002'; end if;
    if anchor is null then anchor:=t.posted_on; first_id:=t.id; identity:=public.recurring_merchant_identity(t); amount_sign:=sign(t.amount_minor); low:=t.amount_minor; high:=t.amount_minor; end if;
    if identity<>public.recurring_merchant_identity(t) or sign(t.amount_minor)<>amount_sign then raise exception 'Sources do not share merchant and direction' using errcode='22023'; end if;
    low:=least(low,t.amount_minor); high:=greatest(high,t.amount_minor); latest_amount:=t.amount_minor;
    n:=public.recurring_period_index(anchor,p_cadence,t.posted_on);
    if n is null or n<=previous or (previous>=0 and n-previous>3 and not(p_evidence_limited and previous=0)) then raise exception 'Sources do not support this calendar run' using errcode='22023'; end if;
    previous:=n; latest_index:=n;
  end loop;
  if first_id<>p_run_anchor_id or (high::numeric-low::numeric)*100>greatest(abs(low::numeric),abs(high::numeric))*15 then raise exception 'Anchor or amount band does not match evidence' using errcode='22023'; end if;
  normalized:=lower(regexp_replace(clean,'\s+',' ','g'));
  select array_agg(distinct r.id) into related from public.recurring_series r where r.workspace_id=a.workspace_id and r.account_id=a.id and r.currency_code=p_currency_code and
    (r.run_anchor_id=p_run_anchor_id or exists(select 1 from public.recurring_series_transactions e where e.series_id=r.id and e.transaction_id=any(ids)) or
      (r.run_anchor_id is null and r.normalized_label=normalized and r.cadence=p_cadence));
  if cardinality(related)>1 then raise exception 'Sources overlap several reviewed runs; review schedules in Plan' using errcode='22023'; end if;
  if cardinality(related)=1 then
    select * into s from public.recurring_series where id=related[1] for update;
    if s.cadence<>p_cadence then raise exception 'Sources already belong to another cadence' using errcode='22023'; end if;
    if s.assumption_id is not null then
      select * into obligation from public.financial_assumptions where id=s.assumption_id and workspace_id=a.workspace_id for update;
      if not found then raise exception 'Owned schedule not found' using errcode='P0002'; end if;
    end if;
    -- Intentional user schedules win over every inferred confirm/decline/retry.
    if obligation.source='user' then update public.recurring_series set status=p_decision where id=s.id returning * into s; return s; end if;
    if s.run_anchor_id is not null and s.run_anchor_id<>p_run_anchor_id and not s.evidence_invalidated then raise exception 'Original anchor outside this candidate; review existing schedule in Plan' using errcode='22023'; end if;
  end if;
  if p_decision='confirmed' and exists(select 1 from public.recurring_series r join public.financial_assumptions f on f.id=r.assumption_id and f.workspace_id=r.workspace_id
    where r.workspace_id=a.workspace_id and r.account_id=a.id and r.currency_code=p_currency_code and r.id is distinct from s.id and
      r.merchant_identity=identity and f.enabled and f.confirmed and f.removed_at is null and
      sign(r.amount_min_minor)=amount_sign and greatest(abs(r.amount_min_minor::numeric),abs(low::numeric))*15>=abs(r.amount_min_minor::numeric-low::numeric)*100) then
    raise exception 'An active schedule already covers this merchant and amount; review it in Plan before confirming another run' using errcode='22023';
  end if;
  if s.id is null then
    insert into public.recurring_series(workspace_id,account_id,label,normalized_label,cadence,currency_code,amount_min_minor,amount_max_minor,occurrences,confidence,status,run_anchor_id,merchant_identity)
    values(a.workspace_id,a.id,clean,'run:'||p_run_anchor_id::text,p_cadence,p_currency_code,low,high,count_evidence,null,p_decision,p_run_anchor_id,identity) returning * into s;
  else
    update public.recurring_series set label=clean,run_anchor_id=p_run_anchor_id,merchant_identity=identity,amount_min_minor=low,amount_max_minor=high,occurrences=count_evidence,confidence=null,status=p_decision,
      evidence_invalidated=false,evidence_baseline=null,assumption_restore=null,invalidated_assumption_version=null where id=s.id returning * into s;
  end if;
  if p_decision='confirmed' then
    if obligation.id is null then
      insert into public.financial_assumptions(workspace_id,account_id,kind,name,amount_minor,currency_code,cadence,starts_on,schedule_anchor_on,source,confidence,confirmed,enabled)
      values(a.workspace_id,a.id,case when latest_amount>0 then 'income' else 'expense' end,clean,latest_amount,p_currency_code,p_cadence,public.recurring_scheduled_date(anchor,p_cadence,latest_index),anchor,'recurring_confirmed',null,true,true) returning * into obligation;
      update public.recurring_series set assumption_id=obligation.id where id=s.id returning * into s;
    else
      update public.financial_assumptions set amount_minor=latest_amount,cadence=p_cadence,starts_on=public.recurring_scheduled_date(anchor,p_cadence,latest_index),schedule_anchor_on=anchor,
        confirmed=true,enabled=true,confidence=null where id=obligation.id;
    end if;
  elsif obligation.id is not null then update public.financial_assumptions set enabled=false where id=obligation.id; end if;
  delete from public.recurring_series_transactions where series_id=s.id and workspace_id=a.workspace_id;
  insert into public.recurring_series_transactions(series_id,transaction_id,workspace_id) select s.id,id,a.workspace_id from unnest(ids) id;
  return s;
end;
$$;
revoke all on function public.recurring_merchant_identity(public.transactions),public.recurring_scheduled_date(date,text,integer),public.recurring_period_index(date,text,date) from public,anon,authenticated;
revoke all on function public.review_recurring_series(text,uuid,text,text,text,jsonb,uuid,boolean) from public,anon;
grant execute on function public.review_recurring_series(text,uuid,text,text,text,jsonb,uuid,boolean) to authenticated;

create or replace function public.propagate_recurring_evidence() returns trigger language plpgsql security definer set search_path='' as $$
declare series public.recurring_series%rowtype; assumption public.financial_assumptions%rowtype; baseline jsonb; current_evidence jsonb; new_version integer;
begin
  if public.recurring_evidence_snapshot(old)=public.recurring_evidence_snapshot(new) then return new; end if;
  for series in select s.* from public.recurring_series s where s.workspace_id=new.workspace_id and s.status='confirmed'
    and exists(select 1 from public.recurring_series_transactions e where e.series_id=s.id and e.transaction_id=new.id) order by s.id for update loop
    select * into assumption from public.financial_assumptions where id=series.assumption_id and workspace_id=series.workspace_id for update;
    if not series.evidence_invalidated then
      select jsonb_agg(case when t.id=old.id then public.recurring_evidence_snapshot(old) else public.recurring_evidence_snapshot(t) end order by t.id) into baseline
        from public.recurring_series_transactions e join public.transactions t on t.id=e.transaction_id and t.workspace_id=e.workspace_id where e.series_id=series.id;
      update public.recurring_series set evidence_invalidated=true,evidence_baseline=baseline,
        assumption_restore=case when assumption.source='recurring_confirmed' then jsonb_build_object('enabled',assumption.enabled,'confirmed',assumption.confirmed) else null end where id=series.id;
      if assumption.source='recurring_confirmed' and (assumption.enabled or assumption.confirmed) then
        update public.financial_assumptions set enabled=false,confirmed=false where id=assumption.id returning version into new_version;
        update public.recurring_series set invalidated_assumption_version=new_version where id=series.id;
      end if;
    else
      select jsonb_agg(public.recurring_evidence_snapshot(t) order by t.id) into current_evidence from public.recurring_series_transactions e join public.transactions t on t.id=e.transaction_id and t.workspace_id=e.workspace_id where e.series_id=series.id;
      -- Old baselines did not record merchant IDs. Preserve those originals and compare
      -- their recorded fields; every new baseline includes merchant identity exactly.
      if current_evidence=series.evidence_baseline or (not exists(select 1 from jsonb_array_elements(series.evidence_baseline) e where e.value ? 'merchant_id') and
        (select jsonb_agg(e.value-'merchant_id' order by e.value->>'id') from jsonb_array_elements(current_evidence) e)=series.evidence_baseline) then
        update public.recurring_series set evidence_invalidated=false,evidence_baseline=null,assumption_restore=null,invalidated_assumption_version=null where id=series.id;
        if assumption.source='recurring_confirmed' and assumption.version=series.invalidated_assumption_version and series.assumption_restore is not null then
          update public.financial_assumptions set enabled=(series.assumption_restore->>'enabled')::boolean,confirmed=(series.assumption_restore->>'confirmed')::boolean where id=assumption.id;
        end if;
      end if;
    end if;
  end loop;
  return new;
end;
$$;

-- Compatibility callers still enter the same owned/locked validation; no legacy bypass.
create or replace function public.confirm_recurring_series(p_account_id uuid,p_label text,p_cadence text,p_currency_code text,p_amount_min_minor bigint,p_amount_max_minor bigint,p_occurrences integer,p_confidence integer,p_transaction_ids uuid[])
returns public.recurring_series language plpgsql security definer set search_path='' as $$
declare evidence jsonb; anchor_id uuid; low bigint; high bigint; owned_workspace uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select workspace_id into owned_workspace from public.accounts where id=p_account_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Account not found' using errcode='P0002'; end if;
  if p_occurrences is null or p_occurrences not between 3 and 1000 or p_transaction_ids is null or cardinality(p_transaction_ids)<>p_occurrences or p_confidence is null or p_confidence not between 0 and 100 then raise exception 'Invalid evidence count/heuristic score' using errcode='22023'; end if;
  select jsonb_agg(public.recurring_evidence_snapshot(t)||jsonb_build_object('version',t.version) order by t.posted_on,t.id),min(t.amount_minor),max(t.amount_minor) into evidence,low,high
    from public.transactions t where t.id=any(p_transaction_ids) and t.workspace_id=owned_workspace and t.account_id=p_account_id;
  if evidence is null or jsonb_array_length(evidence)<>p_occurrences then raise exception 'Evidence not found' using errcode='P0002'; end if;
  if p_amount_min_minor is distinct from low or p_amount_max_minor is distinct from high then raise exception 'Evidence amounts changed' using errcode='40001'; end if;
  anchor_id:=(evidence->0->>'id')::uuid;
  return public.review_recurring_series('confirmed',p_account_id,p_label,p_cadence,p_currency_code,evidence,anchor_id);
end;
$$;
revoke all on function public.confirm_recurring_series(uuid,text,text,text,bigint,bigint,integer,integer,uuid[]) from public,anon;
grant execute on function public.confirm_recurring_series(uuid,text,text,text,bigint,bigint,integer,integer,uuid[]) to authenticated;

-- Compatibility callers still enter the same owned/locked validation; no legacy bypass.
create or replace function public.decline_recurring_series(p_account_id uuid,p_label text,p_cadence text,p_currency_code text,p_amount_min_minor bigint,p_amount_max_minor bigint,p_occurrences integer,p_confidence integer,p_transaction_ids uuid[])
returns public.recurring_series language plpgsql security definer set search_path='' as $$
declare evidence jsonb; anchor_id uuid; low bigint; high bigint; owned_workspace uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select workspace_id into owned_workspace from public.accounts where id=p_account_id and public.owns_workspace(workspace_id);
  if not found then raise exception 'Account not found' using errcode='P0002'; end if;
  if p_occurrences is null or p_occurrences not between 3 and 1000 or p_transaction_ids is null or cardinality(p_transaction_ids)<>p_occurrences or p_confidence is null or p_confidence not between 0 and 100 then raise exception 'Invalid evidence count/heuristic score' using errcode='22023'; end if;
  select jsonb_agg(public.recurring_evidence_snapshot(t)||jsonb_build_object('version',t.version) order by t.posted_on,t.id),min(t.amount_minor),max(t.amount_minor) into evidence,low,high
    from public.transactions t where t.id=any(p_transaction_ids) and t.workspace_id=owned_workspace and t.account_id=p_account_id;
  if evidence is null or jsonb_array_length(evidence)<>p_occurrences then raise exception 'Evidence not found' using errcode='P0002'; end if;
  if p_amount_min_minor is distinct from low or p_amount_max_minor is distinct from high then raise exception 'Evidence amounts changed' using errcode='40001'; end if;
  anchor_id:=(evidence->0->>'id')::uuid;
  return public.review_recurring_series('dismissed',p_account_id,p_label,p_cadence,p_currency_code,evidence,anchor_id);
end;
$$;
revoke all on function public.decline_recurring_series(uuid,text,text,text,bigint,bigint,integer,integer,uuid[]) from public,anon;
grant execute on function public.decline_recurring_series(uuid,text,text,text,bigint,bigint,integer,integer,uuid[]) to authenticated;

create or replace function public.record_recurring_occurrence(p_assumption_id uuid, p_assumption_version integer, p_scheduled_on date,
  p_transaction_id uuid, p_transaction_version integer, p_completes_occurrence boolean)
returns public.recurring_occurrence_settlements language plpgsql security definer set search_path='' as $$
declare a public.financial_assumptions%rowtype; t public.transactions%rowtype; result public.recurring_occurrence_settlements%rowtype;
  period integer; anchor date;
begin
  -- Transaction corrections acquire their posting before the recurring-evidence trigger locks its assumption.
  -- Keep the same order, then recheck both owned records and versions under those locks.
  select * into t from public.transactions where id=p_transaction_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Transaction not found' using errcode='P0002'; end if;
  select * into a from public.financial_assumptions where id=p_assumption_id and workspace_id=t.workspace_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Assumption not found' using errcode='P0002'; end if;
  if p_assumption_version is null or a.version<>p_assumption_version then raise exception 'Assumption changed; reload before associating' using errcode='40001'; end if;
  if not a.confirmed or not a.enabled or a.removed_at is not null or a.account_id is null or a.amount_minor=0 or a.cadence not in ('weekly','biweekly','monthly','quarterly','yearly') then
    raise exception 'Choose an active confirmed recurring assumption' using errcode='22023';
  end if;
  if p_scheduled_on is null or p_scheduled_on<a.starts_on or (a.ends_on is not null and p_scheduled_on>a.ends_on) then raise exception 'Invalid occurrence date' using errcode='22023'; end if;
  anchor:=coalesce(a.schedule_anchor_on,a.starts_on);
  period:=public.recurring_period_index(anchor,a.cadence,p_scheduled_on);
  if period is null or public.recurring_scheduled_date(anchor,a.cadence,period)<>p_scheduled_on then raise exception 'Date is not a scheduled occurrence' using errcode='22023'; end if;
  if p_transaction_version is null or t.version<>p_transaction_version then raise exception 'Transaction changed; reload before associating' using errcode='40001'; end if;
  if t.account_id<>a.account_id or t.currency_code<>a.currency_code or t.status not in ('pending','posted') or t.kind<>'ordinary' or cardinality(t.review_reasons)<>0 or t.amount_minor=0 or sign(t.amount_minor)<>sign(a.amount_minor) or p_completes_occurrence is null then
    raise exception 'Transaction does not fit this obligation' using errcode='22023';
  end if;
  insert into public.recurring_occurrence_settlements(workspace_id,assumption_id,scheduled_on,transaction_id,completes_occurrence,receipt,actor_id)
  values(a.workspace_id,a.id,p_scheduled_on,t.id,p_completes_occurrence,jsonb_build_object('account_id',t.account_id,'amount_minor',t.amount_minor::text,'currency_code',t.currency_code,'kind',t.kind,'review_reasons',t.review_reasons),auth.uid()) returning * into result;
  return result;
end;
$$;

-- Restore new anchors while retaining existing version, latest-event and rollover guards.
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

-- Compact transport: exact expected source versions are checked under posting locks;
-- the existing shared decision function still validates complete owned snapshots.
create function public.review_recurring_series_versions(p_decision text,p_account_id uuid,p_label text,p_cadence text,p_currency_code text,p_evidence jsonb,p_run_anchor_id uuid,p_evidence_limited boolean default false)
returns public.recurring_series language plpgsql security definer set search_path='' as $$
declare workspace uuid; ids uuid[]; item jsonb; posting public.transactions%rowtype; receipts jsonb:='[]'::jsonb; expected integer; n integer;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
 select workspace_id into workspace from public.accounts where id=p_account_id and public.owns_workspace(workspace_id);
 if not found then raise exception 'Account not found' using errcode='P0002'; end if;
 if p_evidence is null or jsonb_typeof(p_evidence)<>'array' then raise exception 'Invalid expected source versions' using errcode='22023'; end if;
 n:=jsonb_array_length(p_evidence);
 if n not between 3 and 1000 then raise exception 'Evidence must list 3 to 1000 sources' using errcode='22023'; end if;
 for item in select value from jsonb_array_elements(p_evidence) loop
   if jsonb_typeof(item)<>'object' or not(item ?& array['id','version']) or item-array['id','version']<>'{}'::jsonb
     or jsonb_typeof(item->'id') is distinct from 'string' or (item->>'id')!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     or jsonb_typeof(item->'version') is distinct from 'number' or (item->>'version')!~'^[0-9]+$' or (item->>'version')::numeric>2147483647 then
     raise exception 'Invalid source version receipt' using errcode='22023';
   end if;
 end loop;
 select array_agg((value->>'id')::uuid) into ids from jsonb_array_elements(p_evidence);
 if (select count(distinct id) from unnest(ids) id)<>n then raise exception 'Duplicate sources' using errcode='22023'; end if;
 perform id from public.transactions where id=any(ids) and workspace_id=workspace and account_id=p_account_id order by id for update;
 if (select count(*) from public.transactions where id=any(ids) and workspace_id=workspace and account_id=p_account_id)<>n then raise exception 'Evidence not found' using errcode='P0002'; end if;
 for posting in select * from public.transactions where id=any(ids) and workspace_id=workspace and account_id=p_account_id order by posted_on,id loop
   select (value->>'version')::integer into expected from jsonb_array_elements(p_evidence) where (value->>'id')::uuid=posting.id;
   if expected is distinct from posting.version then raise exception 'Source changed; reload before deciding' using errcode='40001'; end if;
   receipts:=receipts||jsonb_build_array(public.recurring_evidence_snapshot(posting)||jsonb_build_object('version',posting.version));
 end loop;
 return public.review_recurring_series(p_decision,p_account_id,p_label,p_cadence,p_currency_code,receipts,p_run_anchor_id,p_evidence_limited);
end;
$$;
revoke all on function public.review_recurring_series_versions(text,uuid,text,text,text,jsonb,uuid,boolean) from public,anon;
grant execute on function public.review_recurring_series_versions(text,uuid,text,text,text,jsonb,uuid,boolean) to authenticated;

-- Keep existing owned edit, retry, version and history guards; persist calendar semantics.
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
    or p_patch = '{}'::jsonb or p_patch - array['name','amount_minor','kind','cadence','starts_on','ends_on','enabled','removed'] <> '{}'::jsonb
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
  perform set_config('moneo.planning_request_id', p_request_id::text, true);
  update public.financial_assumptions set name = btrim(edited.name), amount_minor = edited.amount_minor,
    kind = case when edited.amount_minor >= 0 then 'income' else 'expense' end,
    cadence = edited.cadence, starts_on = edited.starts_on, schedule_anchor_on = edited.schedule_anchor_on, ends_on = edited.ends_on,
    source = 'user', confirmed = true,
    enabled = case when p_patch ? 'removed' then false else edited.enabled end,
    removed_at = case when p_patch ? 'removed' then now() else null end
  where id = p_id;
  perform set_config('moneo.planning_request_id', '', true);
  select id into strict event_id from public.planning_events where workspace_id = row_value.workspace_id and request_id = p_request_id;
  return event_id;
end;
$$;
