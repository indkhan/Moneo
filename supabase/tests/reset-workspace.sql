-- Synthetic users only. The migration runner executes this inside a rollback.
-- Seeds every application table for two workspaces (same fixture as workspace-isolation.sql),
-- resets the first as its owner and checks nothing of it survives while the second is untouched.
do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  workspace_a uuid;
  workspace_b uuid;
  fresh uuid;
  seed_ws uuid;
  seed_user uuid;
  app_schema text;
  target_table text;
  columns text;
  data jsonb;
  total integer;
  before_b jsonb := '{}';
begin
  select n.nspname into app_schema from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid='public.accounts'::regclass;
  insert into auth.users(id,email) values(user_a,'qa-'||user_a||'@example.invalid'),(user_b,'qa-'||user_b||'@example.invalid');
  select id into strict workspace_a from public.workspaces where owner_id=user_a;
  select id into strict workspace_b from public.workspaces where owner_id=user_b;
  foreach seed_user in array array[user_a,user_b] loop
  select id into strict seed_ws from public.workspaces where owner_id=seed_user;
  perform set_config('request.jwt.claim.sub', seed_user::text, true);
  foreach target_table in array array['accounts','balance_snapshots','data_sources','imports','source_transactions','categories','merchants',
    'transactions','pending_hold_resolutions','transaction_sources','correction_events','goals','goal_allocations','financial_assumptions','scenarios','scenario_overrides',
    'forecast_runs','background_jobs','saved_analyses','artifacts','artifact_versions','artifact_state','dashboard_items','conversations','messages',
    'recurring_series','recurring_series_transactions','recurring_occurrence_settlements','fx_rates','spending_plans','transaction_views','planning_events','chat_requests','manual_transaction_entries','transaction_batches','workspace_settings','dashboard_layouts','transaction_split_sets','transaction_splits','summary_runs','goal_events','wealth_items','wealth_events','goal_reservation_events','forecast_preferences','forecast_preference_events','money_metadata_events','spending_plan_limits','artifact_generation_requests','scenario_events','transaction_links','transaction_link_fees','insight_preferences','insight_dismissals','import_control_events','import_staging','organization_rules','organization_reviews'] loop
    -- The same fixture also verifies older private upgrade baselines.
    if target_table in ('organization_rules','organization_reviews') and to_regclass(format('%I.%I',app_schema,target_table)) is null then continue; end if;
    data := jsonb_build_object('id',md5(target_table||seed_ws)::uuid,'workspace_id',seed_ws,'name','Synthetic foreign',
      'account_id',md5('accounts'||seed_ws)::uuid,'currency_code','EUR','amount_minor','100',
      'as_of','2026-10-01T00:00:00Z','provenance','synthetic','source_id',md5('data_sources'||seed_ws)::uuid,
      'filename','synthetic.csv','storage_path','synthetic','file_hash',seed_ws::text,'mapping','{}'::jsonb,
      'import_id',md5('imports'||seed_ws)::uuid,'row_number',2,'original_row','{}'::jsonb,'review_rows',1,
      'normalized_name','synthetic foreign','posted_on','2026-10-01','description','Synthetic foreign',
      'category_id',md5('categories'||seed_ws)::uuid,'merchant_id',md5('merchants'||seed_ws)::uuid,
      'transaction_id',md5('transactions'||seed_ws)::uuid,'source_transaction_id',md5('source_transactions'||seed_ws)::uuid,
      'actor_id',seed_user,'before','{}'::jsonb,'after','{}'::jsonb,'target_minor','10000','goal_id',md5('goals'||seed_ws)::uuid,
      'cadence','monthly','starts_on','2026-10-01','source','synthetic','scenario_id',md5('scenarios'||seed_ws)::uuid,
      'assumption_id',md5('financial_assumptions'||seed_ws)::uuid,'amount_delta_minor','0',
      'horizon_start','2026-10-01','horizon_end','2026-10-31','inputs','{}'::jsonb,'result','{}'::jsonb) || jsonb_build_object(
      'job_id',md5('background_jobs'||seed_ws)::uuid,'title','Synthetic foreign','body','Synthetic foreign','evidence','{}'::jsonb,
      'artifact_id',md5('artifacts'||seed_ws)::uuid,'version',1,'manifest','{}'::jsonb,'state','{}'::jsonb,
      'conversation_id',md5('conversations'||seed_ws)::uuid,'role','user','content','Synthetic foreign','message','Synthetic foreign',
      'label','Synthetic foreign','normalized_label','synthetic foreign','amount_min_minor','100','amount_max_minor','100','occurrences',3,
      'series_id',md5('recurring_series'||seed_ws)::uuid,'from_currency','EUR','to_currency','USD','rate_text','1.1','rate_date','2026-10-01',
      'request_id',md5('request'||target_table||seed_ws)::uuid,'original_record','{}'::jsonb,'selection','[]'::jsonb,'patch','{}'::jsonb,
      'limit_minor','10000','entity_type','assumption','entity_id',md5('financial_assumptions'||seed_ws)::uuid);
    data := data || jsonb_build_object('kind', case target_table when 'data_sources' then 'file' when 'financial_assumptions' then 'income'
      when 'background_jobs' then 'financial_review' when 'artifacts' then 'spending_explorer' else 'ordinary' end,
      'status', case target_table when 'source_transactions' then 'review' when 'imports' then 'completed' when 'background_jobs' then 'completed'
        when 'chat_requests' then 'running' when 'artifact_versions' then 'validated' when 'recurring_series' then 'pending' when 'goals' then 'active' else 'posted' end);
    if target_table='artifact_versions' then data := data || '{"source":"return {};"}'::jsonb; end if;
    if target_table='pending_hold_resolutions' then data := data || jsonb_build_object('pending_transaction_id',md5('transactions'||seed_ws)::uuid,'released_minor','100','operation','cancel','input','{}'::jsonb,'receipt','{}'::jsonb,'note','Synthetic foreign hold'); end if;
    if target_table='balance_snapshots' then data := data - 'source_transaction_id'; end if;
    if target_table='dashboard_layouts' then data := data || '{"items":[]}'::jsonb; end if;
    if target_table='transaction_splits' then data := data || jsonb_build_object('parent_transaction_id',md5('transactions'||seed_ws)::uuid,'split_set_id',md5('transaction_split_sets'||seed_ws)::uuid,'ordinal',1); end if;
    if target_table='summary_runs' then data := data || '{"period_start":"2026-10-01"}'::jsonb; end if;
    if target_table='spending_plan_limits' then data := data || jsonb_build_object('plan_id',md5('spending_plans'||seed_ws)::uuid,'enabled',true,'effective_month','2026-10-01','version',99); end if;
    if target_table='artifact_generation_requests' then data := data || jsonb_build_object('purpose','calculator','description','Synthetic request','status','running','result',null); end if;
    if target_table='insight_dismissals' then data := data || jsonb_build_object('evidence_key',repeat('a',64),'insight_type','data_quality'); end if;
    if target_table='import_staging' then data := data || jsonb_build_object('stage_version',1,'rows','[]'::jsonb,'route_accounts','{}'::jsonb); end if;
    if target_table='import_control_events' then data := data || jsonb_build_object('action','cancel'); end if;
    if target_table='organization_rules' then data := data || jsonb_build_object('description_key','synthetic foreign','approved_by',seed_user); end if;
    if target_table='organization_reviews' then data := data || jsonb_build_object('status','pending','selection',jsonb_build_array(jsonb_build_object('id',md5('transactions'||seed_ws)::uuid,'version',1)),
      'snapshots',jsonb_build_array(jsonb_build_object('id',md5('transactions'||seed_ws)::uuid,'version',1)),'evidence','[]'::jsonb,'patch',jsonb_build_object('category_id',md5('categories'||seed_ws)::uuid)); end if;
    if target_table='recurring_occurrence_settlements' then data := data || jsonb_build_object('scheduled_on','2026-10-01','completes_occurrence',true,'receipt','{}'::jsonb); end if;
    if target_table='transaction_links' then data := data || jsonb_build_object('operation','refund','primary_transaction_id',md5('transactions'||seed_ws)::uuid,'counterpart_transaction_id',md5('transactions'||seed_ws)::uuid,'input','{}'::jsonb,'before_rows','[]'::jsonb,'after_rows','[]'::jsonb); end if;
    if target_table='transaction_link_fees' then data := data || jsonb_build_object('link_id',md5('transaction_links'||seed_ws)::uuid,'fee_minor','10','treatment','included','note','Synthetic fee'); end if;
    if target_table='scenario_events' then data := data || jsonb_build_object('entity_type','scenario','entity_id',md5('scenarios'||seed_ws)::uuid); end if;
    if target_table='money_metadata_events' then data := data || jsonb_build_object('entity_type','account','entity_id',md5('accounts'||seed_ws)::uuid,'input','{}'::jsonb); end if;
    if target_table='wealth_items' then data := data || '{"kind":"asset","as_of":"2026-10-01"}'::jsonb; end if;
    if target_table='wealth_events' then data := data || jsonb_build_object('item_id',md5('wealth_items'||seed_ws)::uuid); end if;
    if target_table='goal_reservation_events' then data := data || jsonb_build_object('allocation_id',md5('goal_allocations'||seed_ws)::uuid); end if;
    select string_agg(quote_ident(c.column_name),',' order by c.ordinal_position) into columns
      from information_schema.columns c where c.table_schema=app_schema and c.table_name=target_table and data ? c.column_name;
    execute format('insert into %I.%I (%s) select %s from jsonb_populate_record(null::%I.%I,$1)',app_schema,target_table,columns,columns,app_schema,target_table) using data;
  end loop;
  insert into public.financial_evidence_receipts(id,workspace_id,scopes,receipt)
    values(md5('financial_evidence_receipts'||seed_ws)::uuid,seed_ws,array[]::text[],
      jsonb_build_object('id',md5('financial_evidence_receipts'||seed_ws)::uuid,'workspaceId',seed_ws,'query','{}'::jsonb,'metrics','[]'::jsonb,'sources','[]'::jsonb,'scopes','[]'::jsonb));
  insert into public.agent_runs(id,workspace_id) values(md5('agent_runs'||seed_ws)::uuid,seed_ws);
  insert into public.agent_tasks(run_id,workspace_id,agent) values(md5('agent_runs'||seed_ws)::uuid,seed_ws,'lead');
  insert into public.agent_proposals(run_id,workspace_id,agent,kind,conflict_key,title) values(md5('agent_runs'||seed_ws)::uuid,seed_ws,'lead','finding','synthetic','Synthetic finding');
  insert into public.bank_connections(id,workspace_id,aspsp_name,aspsp_country) values(md5('bank_connections'||seed_ws)::uuid,seed_ws,'Synthetic Bank','DE');
  insert into public.bank_connection_accounts(connection_id,workspace_id,provider_account_uid,currency_code,account_name)
    values(md5('bank_connections'||seed_ws)::uuid,seed_ws,'synthetic','EUR','Synthetic Bank');
  -- Links that the delete guards protect: a refund of the seeded transaction and an active artifact version.
  perform set_config('moneo.link_edit','on',true);
  insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code)
    values(md5('original'||seed_ws)::uuid,seed_ws,md5('accounts'||seed_ws)::uuid,'2026-10-02','Synthetic original',-100,'EUR');
  insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,refund_of_id)
    values(seed_ws,md5('accounts'||seed_ws)::uuid,'2026-10-03','Synthetic refund',50,'EUR',md5('original'||seed_ws)::uuid);
  perform set_config('moneo.link_edit','',true);
  update public.artifacts set active_version_id=md5('artifact_versions'||seed_ws)::uuid where id=md5('artifacts'||seed_ws)::uuid;
  end loop;

  for target_table in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attname='workspace_id' and not a.attisdropped
    where n.nspname=app_schema and c.relkind='r' loop
    execute format('select count(*) from %I.%I where workspace_id=$1',app_schema,target_table) into total using workspace_a;
    if total=0 then raise exception 'Missing reset fixture for table %; update reset coverage',target_table; end if;
    execute format('select count(*) from %I.%I where workspace_id=$1',app_schema,target_table) into total using workspace_b;
    before_b := before_b || jsonb_build_object(target_table,total);
  end loop;

  perform set_config('request.jwt.claim.sub', user_a::text, true);
  execute 'set local role authenticated';
  perform public.reset_workspace();
  execute 'reset role';

  select id into strict fresh from public.workspaces where owner_id=user_a;
  if fresh=workspace_a then raise exception 'Reset must replace the workspace id'; end if;
  if exists(select 1 from public.workspaces where id=workspace_a) then raise exception 'Old workspace survived reset'; end if;
  if not exists(select 1 from public.workspaces where id=fresh and name='My finances' and display_currency='EUR') then raise exception 'Fresh workspace must match signup defaults'; end if;
  if exists(select 1 from public.transaction_sources s join public.transactions t on t.id=s.transaction_id where t.workspace_id in (workspace_a,fresh)) then raise exception 'transaction_sources survived reset'; end if;
  for target_table in select key from jsonb_each(before_b) loop
    execute format('select count(*) from %I.%I where workspace_id in ($1,$2)',app_schema,target_table) into total using workspace_a, fresh;
    if total<>0 then raise exception 'Reset left % rows in %',total,target_table; end if;
    execute format('select count(*) from %I.%I where workspace_id=$1',app_schema,target_table) into total using workspace_b;
    if total<>(before_b->>target_table)::integer then raise exception 'Reset changed another workspace in %',target_table; end if;
  end loop;

  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.reset_workspace();
    raise exception 'Anonymous reset succeeded' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
end;
$$;
