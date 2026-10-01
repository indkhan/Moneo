-- Synthetic records only; the runner always rolls back.
do $$
declare
  user_id uuid := gen_random_uuid();
  workspace uuid;
  account uuid := gen_random_uuid();
  assumption uuid := gen_random_uuid();
  category uuid := gen_random_uuid();
  plan uuid := gen_random_uuid();
  request uuid := gen_random_uuid();
  edited uuid;
  removed uuid;
  toggled uuid;
  current_version integer;
  evidence uuid[] := array[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
begin
  insert into auth.users(id,email) values(user_id,'qa-'||user_id||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=user_id;
  perform set_config('request.jwt.claim.sub', user_id::text, true);
  insert into public.accounts(id,workspace_id,name,currency_code) values(account,workspace,'Synthetic','EUR');
  insert into public.financial_assumptions(id,workspace_id,account_id,name,kind,amount_minor,currency_code,cadence,starts_on,source,confirmed)
    values(assumption,workspace,account,'Rent','expense',-10000,'EUR','monthly','2026-10-01','recurring_confirmed',true);
  insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind) values
    (evidence[1],workspace,account,'2026-07-01','Rent',-10000,'EUR','posted','ordinary'),
    (evidence[2],workspace,account,'2026-08-01','Rent',-10000,'EUR','posted','ordinary'),
    (evidence[3],workspace,account,'2026-09-01','Rent',-10000,'EUR','posted','ordinary');
  insert into public.recurring_series(workspace_id,account_id,label,normalized_label,cadence,currency_code,amount_min_minor,amount_max_minor,occurrences,confidence,status,assumption_id)
    values(workspace,account,'Rent','rent','monthly','EUR',-10000,-10000,3,95,'confirmed',assumption);
  edited := public.edit_assumption(assumption,1,'{"amount_minor":"-9007199254740993","name":"Edited rent"}',request);
  if (select amount_minor from public.financial_assumptions where id=assumption) <> -9007199254740993 then raise exception 'Exact money was lost'; end if;
  if (select after->>'amount_minor' from public.planning_events where id=edited) <> '-9007199254740993' then raise exception 'History money must remain exact text'; end if;
  if public.edit_assumption(assumption,1,'{"amount_minor":"-9007199254740993","name":"Edited rent"}',request) <> edited then raise exception 'Retry must be idempotent'; end if;
  begin
    perform public.edit_assumption(assumption,1,'{"enabled":false}',gen_random_uuid());
    raise exception 'Stale edit accepted';
  exception when sqlstate '40001' then null; end;
  begin
    perform public.edit_assumption(assumption,2,'{"source":"recurring_confirmed"}',gen_random_uuid());
    raise exception 'Unvalidated patch accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.edit_assumption(assumption,2,'{"kind":"income"}',gen_random_uuid());
    raise exception 'Inconsistent kind accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.edit_assumption(assumption,2,'{"starts_on":"today"}',gen_random_uuid());
    raise exception 'Ambiguous calendar date accepted';
  exception when sqlstate '22023' then null; end;
  removed := public.edit_assumption(assumption,2,'{"removed":true}',gen_random_uuid());
  if not exists(select 1 from public.financial_assumptions where id=assumption and removed_at is not null and not enabled and source='user') then raise exception 'Removal must preserve a disabled user override'; end if;
  perform public.confirm_recurring_series(account,'Rent','monthly','EUR',-10000,-10000,3,95,evidence);
  if not exists(select 1 from public.financial_assumptions where id=assumption and version=3 and removed_at is not null and not enabled and amount_minor=-9007199254740993) then raise exception 'Recurring retry overwrote intentional removal'; end if;
  begin
    perform public.undo_planning_event(edited,3);
    raise exception 'Undo crossed a later removal';
  exception when sqlstate '40001' then null; end;
  perform public.undo_planning_event(removed,3);
  if not exists(select 1 from public.financial_assumptions where id=assumption and removed_at is null and enabled and version=4) then raise exception 'Removal undo failed'; end if;
  perform public.undo_planning_event(edited,4);
  if not exists(select 1 from public.financial_assumptions where id=assumption and amount_minor=-10000 and source='recurring_confirmed' and version=5) then raise exception 'Sequential undo failed'; end if;
  perform public.undo_planning_event(edited,4);
  if (select version from public.financial_assumptions where id=assumption) <> 5 then raise exception 'Undo retry changed state'; end if;
  insert into public.categories(id,workspace_id,name) values(category,workspace,'Synthetic budget');
  insert into public.spending_plans(id,workspace_id,category_id,currency_code,limit_minor) values(plan,workspace,category,'EUR',10000);
  toggled := public.edit_spending_plan(plan,1,'{"enabled":false,"limit_minor":"20000"}',gen_random_uuid());
  perform public.undo_planning_event(toggled,2);
  if not exists(select 1 from public.spending_plans where id=plan and enabled and limit_minor=10000 and version=3) then raise exception 'Spending plan undo failed'; end if;
  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  begin
    perform public.edit_assumption(assumption,5,'{"enabled":false}',gen_random_uuid());
    raise exception 'Foreign workspace edit accepted';
  exception when sqlstate 'P0002' then null; end;
  begin
    perform public.undo_planning_event(edited,5);
    raise exception 'Foreign workspace undo accepted';
  exception when sqlstate 'P0002' then null; end;
  if has_table_privilege('authenticated','public.financial_assumptions','UPDATE') or has_table_privilege('authenticated','public.planning_events','UPDATE') then raise exception 'Direct mutation bypass remains'; end if;
  execute 'set local role authenticated';
  if exists(select 1 from public.planning_events where workspace_id=workspace) then raise exception 'Foreign planning history exposed'; end if;
  perform set_config('request.jwt.claim.sub', user_id::text, true);
  if not exists(select 1 from public.planning_events where workspace_id=workspace) then raise exception 'Own planning history missing'; end if;
  execute 'reset role';
end;
$$;
