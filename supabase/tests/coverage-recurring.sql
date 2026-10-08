-- Synthetic fixtures only. Runner rewrites every target into its owned private schema
-- and always rolls back. Real auth.uid(), authenticated grants and RLS stay in use.
do $$
declare actor uuid:=gen_random_uuid(); foreign_actor uuid:=gen_random_uuid(); w uuid; foreign_w uuid;
  account uuid:=gen_random_uuid(); foreign_account uuid:=gen_random_uuid(); ids uuid[];
  cadence text; dates date[]; series public.recurring_series%rowtype; receipt public.recurring_occurrence_settlements%rowtype;
  evidence jsonb; stale jsonb; before_ledger jsonb; assumption_version integer; i integer;
begin
  insert into auth.users(id,email) values(actor,'mne014-'||actor||'@example.invalid'),(foreign_actor,'mne014-other-'||foreign_actor||'@example.invalid');
  select id into strict w from public.workspaces where owner_id=actor;
  select id into strict foreign_w from public.workspaces where owner_id=foreign_actor;
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,w,'MNE014 synthetic cash','EUR'),(foreign_account,foreign_w,'MNE014 other cash','EUR');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  -- Quarterly first gives a meaningful baseline failure in the existing owned RPC.
  foreach cadence in array array['quarterly','yearly','biweekly','monthly','weekly'] loop
    dates:=case cadence
      when 'quarterly' then array['2024-01-31','2024-04-30','2024-07-31']::date[]
      when 'yearly' then array['2024-02-29','2025-02-28','2026-02-28']::date[]
      when 'biweekly' then array['2026-01-02','2026-01-16','2026-01-30']::date[]
      when 'monthly' then array['2026-01-31','2026-02-28','2026-03-31']::date[]
      else array['2026-01-02','2026-01-09','2026-01-16']::date[] end;
    ids:=array[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
    for i in 1..3 loop
      insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind)
        values(ids[i],w,account,dates[i],'MNE014 '||cadence||' invoice '||i,-9007199254740993,'EUR','posted','ordinary');
    end loop;
    select jsonb_agg(public.recurring_evidence_snapshot(t)||jsonb_build_object('version',t.version) order by t.posted_on,t.id) into evidence from public.transactions t where id=any(ids);
    select jsonb_agg(to_jsonb(t) order by t.id) into before_ledger from public.transactions t where workspace_id=w;
    execute 'set local role authenticated';
    series:=public.confirm_recurring_series(account,'MNE014 '||cadence,cadence,'EUR',-9007199254740993,-9007199254740993,3,70,ids);
    if series.cadence<>cadence or series.amount_min_minor<>-9007199254740993 or series.status<>'confirmed' then raise exception 'Cadence confirmation lost exact source truth'; end if;
    execute 'reset role';
    if (select jsonb_agg(to_jsonb(t) order by t.id) from public.transactions t where workspace_id=w) is distinct from before_ledger then raise exception 'Confirmation changed ledger sources'; end if;
    -- New UI boundary must reject stale evidence before persisting any decision.
    stale:=jsonb_set(evidence,'{0,version}',to_jsonb((evidence->0->>'version')::integer+1));
    execute 'set local role authenticated';
    begin
      perform public.review_recurring_series('confirmed',account,'MNE014 '||cadence,cadence,'EUR',stale,ids[1]);
      raise exception 'Stale candidate evidence accepted';
    exception when sqlstate '40001' then null; end;
    execute 'reset role';
    select version into assumption_version from public.financial_assumptions where id=series.assumption_id;
    execute 'set local role authenticated';
    receipt:=public.record_recurring_occurrence(series.assumption_id,assumption_version,dates[3],ids[3],0,true);
    if receipt.receipt->>'amount_minor'<>'-9007199254740993' then raise exception 'Settlement money not exact'; end if;
    receipt:=public.undo_recurring_occurrence(receipt.id,receipt.version);
    if receipt.undone_at is null or receipt.receipt->>'amount_minor'<>'-9007199254740993' then raise exception 'Undo lost receipt'; end if;
    begin
      perform public.record_recurring_occurrence(series.assumption_id,assumption_version,dates[3]+1,ids[3],0,true);
      raise exception 'Nonscheduled date accepted';
    exception when sqlstate '22023' then null; end;
    execute 'reset role';
    -- An intentional Plan override survives confirm AND decline; history/versions still apply.
    perform public.edit_assumption(series.assumption_id,assumption_version,'{"amount_minor":"-12345","cadence":"monthly","starts_on":"2026-10-10"}',gen_random_uuid());
    select version into assumption_version from public.financial_assumptions where id=series.assumption_id;
    execute 'set local role authenticated';
    perform public.review_recurring_series('dismissed',account,'MNE014 '||cadence,cadence,'EUR',evidence,ids[1]);
    perform public.review_recurring_series('confirmed',account,'MNE014 '||cadence,cadence,'EUR',evidence,ids[1]);
    execute 'reset role';
    if not exists(select 1 from public.financial_assumptions where id=series.assumption_id and amount_minor=-12345 and source='user' and enabled and version=assumption_version and starts_on='2026-10-10') then raise exception 'Candidate decision overwrote intentional schedule'; end if;
    if (select jsonb_agg(to_jsonb(t) order by t.id) from public.transactions t where workspace_id=w) is distinct from before_ledger then raise exception 'Decision/settlement/undo changed ledger sources'; end if;
  end loop;
  perform set_config('request.jwt.claim.sub',foreign_actor::text,true);
  execute 'set local role authenticated';
  if exists(select 1 from public.recurring_series where workspace_id=w) then raise exception 'Foreign series visible'; end if;
  begin
    perform public.review_recurring_series('confirmed',account,'Foreign candidate','weekly','EUR',evidence,ids[1]);
    raise exception 'Foreign source accepted';
  exception when sqlstate 'P0002' then null; end;
  execute 'reset role';
end;
$$;

-- Distinct runs, active-overlap guard and merchant correction share existing triggers.
do $$
declare actor uuid:=gen_random_uuid(); w uuid; account uuid:=gen_random_uuid(); merchant uuid:=gen_random_uuid(); replacement uuid:=gen_random_uuid();
  ids uuid[]:=array[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  first_sources jsonb; second_sources jsonb; first_series public.recurring_series%rowtype; second_series public.recurring_series%rowtype;
  version_before integer; i integer;
begin
  insert into auth.users(id,email) values(actor,'mne014-runs-'||actor||'@example.invalid');
  select id into strict w from public.workspaces where owner_id=actor;
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,w,'Separate synthetic runs','EUR');
  insert into public.merchants(id,workspace_id,name,normalized_name) values(merchant,w,'Stable owned merchant','stable owned merchant'),(replacement,w,'Corrected merchant','corrected merchant');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  for i in 1..6 loop
    insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind,merchant_id)
      values(ids[i],w,account,((case when i<=3 then '2024-01-31' else '2026-01-31' end)::date+make_interval(months=>(i-1)%3))::date,'Different recorded description '||i,-2000,'EUR','posted','ordinary',merchant);
  end loop;
  select jsonb_agg(public.recurring_evidence_snapshot(t)||jsonb_build_object('version',t.version) order by t.posted_on,t.id) into first_sources from public.transactions t where id=any(ids[1:3]);
  select jsonb_agg(public.recurring_evidence_snapshot(t)||jsonb_build_object('version',t.version) order by t.posted_on,t.id) into second_sources from public.transactions t where id=any(ids[4:6]);
  execute 'set local role authenticated';
  first_series:=public.review_recurring_series('confirmed',account,'Same display label','monthly','EUR',first_sources,ids[1]);
  second_series:=public.review_recurring_series('dismissed',account,'Same display label','monthly','EUR',second_sources,ids[4]);
  if first_series.id=second_series.id or first_series.normalized_label=second_series.normalized_label then raise exception 'Separate runs collided'; end if;
  begin
    perform public.review_recurring_series('confirmed',account,'Same display label','monthly','EUR',second_sources,ids[4]);
    raise exception 'Two overlapping active inference schedules accepted';
  exception when sqlstate '22023' then null; end;
  execute 'reset role';
  select version into version_before from public.financial_assumptions where id=first_series.assumption_id;
  perform public.edit_assumption(first_series.assumption_id,version_before,'{"enabled":false}',gen_random_uuid());
  select version into version_before from public.financial_assumptions where id=first_series.assumption_id;
  execute 'set local role authenticated';
  second_series:=public.review_recurring_series('confirmed',account,'Same display label','monthly','EUR',second_sources,ids[4]);
  perform public.review_recurring_series('confirmed',account,'Same display label','monthly','EUR',first_sources,ids[1]);
  execute 'reset role';
  if not exists(select 1 from public.financial_assumptions where id=first_series.assumption_id and source='user' and not enabled and version=version_before) then raise exception 'Inference overwrote manual disable'; end if;
  if (select count(*) from public.financial_assumptions where workspace_id=w and enabled)<>1 then raise exception 'Run confirmation double-counted active inference'; end if;
  -- Fixture-only row correction exercises the real evidence trigger. UI correction/Undo
  -- separately uses verified-transfer receipts in existing regressions/browser gate.
  update public.transactions set merchant_id=replacement,version=version+1 where id=ids[6] and workspace_id=w;
  if not exists(select 1 from public.recurring_series where id=second_series.id and evidence_invalidated) or exists(select 1 from public.financial_assumptions where id=second_series.assumption_id and enabled) then raise exception 'Merchant correction retained inference'; end if;
  update public.transactions set merchant_id=merchant,version=version+1 where id=ids[6] and workspace_id=w;
  if exists(select 1 from public.recurring_series where id=second_series.id and evidence_invalidated) or not exists(select 1 from public.financial_assumptions where id=second_series.assumption_id and enabled) then raise exception 'Merchant restoration failed existing Undo propagation'; end if;
  if (select count(*) from public.planning_events where workspace_id=w) < 4 then raise exception 'Assumption history lost'; end if;
  if (select count(*) from public.transactions where workspace_id=w and amount_minor=-2000 and merchant_id=merchant)<>6 then raise exception 'Correction/restoration changed original money or source count'; end if;
end;
$$;

-- Owned planning Undo restores an anchor, rather than leaving the changed schedule.
do $$
declare actor uuid:=gen_random_uuid(); w uuid; a uuid:=gen_random_uuid(); f uuid:=gen_random_uuid(); e uuid; v integer;
begin
 insert into auth.users(id,email) values(actor,'mne014-anchor-'||actor||'@example.invalid');
 select id into strict w from public.workspaces where owner_id=actor;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 insert into public.accounts(id,workspace_id,name,currency_code) values(a,w,'Anchor history','EUR');
 insert into public.financial_assumptions(id,workspace_id,account_id,kind,name,amount_minor,currency_code,cadence,starts_on,schedule_anchor_on,source,confirmed)
 values(f,w,a,'expense','Anchored schedule',-1000,'EUR','monthly','2026-03-31','2026-01-31','recurring_confirmed',true);
 update public.financial_assumptions set schedule_anchor_on='2026-02-28' where id=f;
 select id into strict e from public.planning_events where entity_id=f and before is not null;
 select version into v from public.financial_assumptions where id=f;
 execute 'set local role authenticated';
 perform public.undo_planning_event(e,v);
 execute 'reset role';
 if not exists(select 1 from public.financial_assumptions where id=f and schedule_anchor_on='2026-01-31') then raise exception 'Undo did not restore calendar anchor'; end if;
end;
$$;
