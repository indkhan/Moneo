-- Synthetic users only. The migration runner executes this inside a rollback.
do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  workspace_a uuid;
  workspace_b uuid;
  app_schema text;
  target_table text;
  columns text;
  data jsonb;
  total integer;
  tested integer := 0;
  call text;
  foreign_transaction uuid;
  foreign_account uuid;
  foreign_goal uuid;
  foreign_import uuid;
  foreign_source uuid;
  foreign_artifact uuid;
  foreign_assumption uuid;
  foreign_plan uuid;
  foreign_event uuid;
begin
  select n.nspname into app_schema from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid='public.accounts'::regclass;
  insert into auth.users(id,email) values(user_a,'qa-'||user_a||'@example.invalid'),(user_b,'qa-'||user_b||'@example.invalid');
  select id into strict workspace_a from public.workspaces where owner_id=user_a;
  select id into strict workspace_b from public.workspaces where owner_id=user_b;
  perform set_config('request.jwt.claim.sub', user_b::text, true);
  -- Each table gets a real foreign record so an empty-table pass cannot hide missing RLS.
  foreach target_table in array array['accounts','balance_snapshots','data_sources','imports','source_transactions','categories','merchants',
    'transactions','transaction_sources','correction_events','goals','goal_allocations','financial_assumptions','scenarios','scenario_overrides',
    'forecast_runs','background_jobs','saved_analyses','artifacts','artifact_versions','artifact_state','dashboard_items','conversations','messages',
    'recurring_series','recurring_series_transactions','fx_rates','spending_plans','transaction_views','planning_events','chat_requests','manual_transaction_entries','transaction_batches','workspace_settings','dashboard_layouts','transaction_split_sets','transaction_splits','summary_runs','goal_events','wealth_items','wealth_events','goal_reservation_events','forecast_preferences','forecast_preference_events','money_metadata_events','spending_plan_limits','artifact_generation_requests','scenario_events','transaction_links','transaction_link_fees','insight_preferences','insight_dismissals','import_control_events'] loop
    data := jsonb_build_object('id',md5(target_table||workspace_b)::uuid,'workspace_id',workspace_b,'name','Synthetic foreign',
      'account_id',md5('accounts'||workspace_b)::uuid,'currency_code','EUR','amount_minor','100',
      'as_of','2026-10-01T00:00:00Z','provenance','synthetic','source_id',md5('data_sources'||workspace_b)::uuid,
      'filename','synthetic.csv','storage_path','synthetic','file_hash',workspace_b::text,'mapping','{}'::jsonb,
      'import_id',md5('imports'||workspace_b)::uuid,'row_number',2,'original_row','{}'::jsonb,'review_rows',1,
      'normalized_name','synthetic foreign','posted_on','2026-10-01','description','Synthetic foreign',
      'category_id',md5('categories'||workspace_b)::uuid,'merchant_id',md5('merchants'||workspace_b)::uuid,
      'transaction_id',md5('transactions'||workspace_b)::uuid,'source_transaction_id',md5('source_transactions'||workspace_b)::uuid,
      'actor_id',user_b,'before','{}'::jsonb,'after','{}'::jsonb,'target_minor','10000','goal_id',md5('goals'||workspace_b)::uuid,
      'cadence','monthly','starts_on','2026-10-01','source','synthetic','scenario_id',md5('scenarios'||workspace_b)::uuid,
      'assumption_id',md5('financial_assumptions'||workspace_b)::uuid,'amount_delta_minor','0',
      'horizon_start','2026-10-01','horizon_end','2026-10-31','inputs','{}'::jsonb,'result','{}'::jsonb) || jsonb_build_object(
      'job_id',md5('background_jobs'||workspace_b)::uuid,'title','Synthetic foreign','body','Synthetic foreign','evidence','{}'::jsonb,
      'artifact_id',md5('artifacts'||workspace_b)::uuid,'version',1,'manifest','{}'::jsonb,'state','{}'::jsonb,
      'conversation_id',md5('conversations'||workspace_b)::uuid,'role','user','content','Synthetic foreign','message','Synthetic foreign',
      'label','Synthetic foreign','normalized_label','synthetic foreign','amount_min_minor','100','amount_max_minor','100','occurrences',3,
      'series_id',md5('recurring_series'||workspace_b)::uuid,'from_currency','EUR','to_currency','USD','rate_text','1.1','rate_date','2026-10-01',
      'request_id',md5('request'||target_table||workspace_b)::uuid,'original_record','{}'::jsonb,'selection','[]'::jsonb,'patch','{}'::jsonb,
      'limit_minor','10000','entity_type','assumption','entity_id',md5('financial_assumptions'||workspace_b)::uuid);
    data := data || jsonb_build_object('kind', case target_table when 'data_sources' then 'file' when 'financial_assumptions' then 'income'
      when 'background_jobs' then 'financial_review' when 'artifacts' then 'spending_explorer' else 'ordinary' end,
      'status', case target_table when 'source_transactions' then 'review' when 'imports' then 'completed' when 'background_jobs' then 'completed'
        when 'chat_requests' then 'running' when 'artifact_versions' then 'validated' when 'recurring_series' then 'pending' when 'goals' then 'active' else 'posted' end);
    if target_table='artifact_versions' then data := data || '{"source":"return {};"}'::jsonb; end if;
    if target_table='balance_snapshots' then data := data - 'source_transaction_id'; end if;
    if target_table='dashboard_layouts' then data := data || '{"items":[]}'::jsonb; end if;
    if target_table='transaction_splits' then data := data || jsonb_build_object('parent_transaction_id',md5('transactions'||workspace_b)::uuid,'split_set_id',md5('transaction_split_sets'||workspace_b)::uuid,'ordinal',1); end if;
    if target_table='summary_runs' then data := data || '{"period_start":"2026-10-01"}'::jsonb; end if;
    if target_table='spending_plan_limits' then data := data || jsonb_build_object('plan_id',md5('spending_plans'||workspace_b)::uuid,'enabled',true,'effective_month','2026-10-01','version',99); end if;
    if target_table='artifact_generation_requests' then data := data || jsonb_build_object('purpose','calculator','description','Synthetic request','status','running','result',null); end if;
    if target_table='insight_dismissals' then data := data || jsonb_build_object('evidence_key',repeat('a',64),'insight_type','data_quality'); end if;
    if target_table='import_control_events' then data := data || jsonb_build_object('action','cancel'); end if;
    if target_table='transaction_links' then data := data || jsonb_build_object('operation','refund','primary_transaction_id',md5('transactions'||workspace_b)::uuid,'counterpart_transaction_id',md5('transactions'||workspace_b)::uuid,'input','{}'::jsonb,'before_rows','[]'::jsonb,'after_rows','[]'::jsonb); end if;
    if target_table='transaction_link_fees' then data := data || jsonb_build_object('link_id',md5('transaction_links'||workspace_b)::uuid,'fee_minor','10','treatment','included','note','Synthetic fee'); end if;
    if target_table='scenario_events' then data := data || jsonb_build_object('entity_type','scenario','entity_id',md5('scenarios'||workspace_b)::uuid); end if;
    if target_table='money_metadata_events' then data := data || jsonb_build_object('entity_type','account','entity_id',md5('accounts'||workspace_b)::uuid,'input','{}'::jsonb); end if;
    if target_table='wealth_items' then data := data || '{"kind":"asset","as_of":"2026-10-01"}'::jsonb; end if;
    if target_table='wealth_events' then data := data || jsonb_build_object('item_id',md5('wealth_items'||workspace_b)::uuid); end if;
    if target_table='goal_reservation_events' then data := data || jsonb_build_object('allocation_id',md5('goal_allocations'||workspace_b)::uuid); end if;
    select string_agg(quote_ident(c.column_name),',' order by c.ordinal_position) into columns
      from information_schema.columns c where c.table_schema=app_schema and c.table_name=target_table and data ? c.column_name;
    execute format('insert into %I.%I (%s) select %s from jsonb_populate_record(null::%I.%I,$1)',app_schema,target_table,columns,columns,app_schema,target_table) using data;
  end loop;
  insert into public.accounts(workspace_id,name,currency_code) values(workspace_a,'Synthetic own','EUR');
  foreign_transaction := md5('transactions'||workspace_b)::uuid;
  foreign_account := md5('accounts'||workspace_b)::uuid;
  foreign_goal := md5('goals'||workspace_b)::uuid;
  foreign_import := md5('imports'||workspace_b)::uuid;
  foreign_source := md5('source_transactions'||workspace_b)::uuid;
  foreign_artifact := md5('artifacts'||workspace_b)::uuid;
  foreign_assumption := md5('financial_assumptions'||workspace_b)::uuid;
  foreign_plan := md5('spending_plans'||workspace_b)::uuid;
  foreign_event := md5('planning_events'||workspace_b)::uuid;
  for target_table in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=app_schema and c.relkind='r' and c.relname <> 'auth_users' loop
    if target_table='workspaces' then execute format('select count(*) from %I.workspaces where id=$1',app_schema) into total using workspace_b;
    elsif target_table='transaction_sources' then execute format('select count(*) from %I.transaction_sources where transaction_id=$1',app_schema) into total using foreign_transaction;
    else execute format('select count(*) from %I.%I where workspace_id=$1',app_schema,target_table) into total using workspace_b;
    end if;
    if total=0 then raise exception 'Missing foreign fixture for table %; update isolation coverage',target_table; end if;
  end loop;
  perform set_config('request.jwt.claim.sub', user_a::text, true);
  execute 'set local role authenticated';
  if public.owns_workspace(workspace_b) then raise exception 'Foreign workspace ownership leaked'; end if;
  if not public.owns_workspace(workspace_a) then raise exception 'Own workspace ownership unavailable'; end if;
  if (select count(*) from public.accounts where workspace_id=workspace_a) <> 1 then raise exception 'Own account must remain readable'; end if;
  for target_table in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=app_schema and c.relkind='r' and c.relname <> 'auth_users' loop
    begin
      if target_table='workspaces' then execute format('select count(*) from %I.workspaces where id=$1',app_schema) into total using workspace_b;
      elsif target_table='transaction_sources' then execute format('select count(*) from %I.transaction_sources where transaction_id=$1',app_schema) into total using foreign_transaction;
      else execute format('select count(*) from %I.%I where workspace_id=$1',app_schema,target_table) into total using workspace_b;
      end if;
      if total <> 0 then raise exception 'Foreign rows visible in %',target_table; end if;
    exception when insufficient_privilege then null; end;
    tested := tested + 1;
  end loop;
  if tested < 31 then raise exception 'Expected every application table to be covered'; end if;
  foreach call in array array[
    format('select public.correct_transaction(%L,0,null,null)',foreign_transaction),
    format('select public.undo_transaction_correction(%L,0)',md5('correction_events'||workspace_b)::uuid),
    format('select public.mark_transaction_transfer(%L,0,%L)',foreign_transaction,gen_random_uuid()),
    format('select public.mark_transaction_refund(%L,0,null)',foreign_transaction),
    format('select public.clear_transaction_link(%L,0)',foreign_transaction),
    format('select public.set_goal_allocation(%L,%L,100)',foreign_goal,foreign_account),
    format('select public.resolve_import_review(%L,%L)',foreign_source,'reject'),
    format('select public.preview_import_undo(%L)',foreign_import),
    format('select public.undo_import(%L,1,0)',foreign_import),
    format('select public.undo_import_before_control(%L,1,0)',foreign_import),
    format('select public.control_import(%L,%L,%L)',foreign_import,'cancel',gen_random_uuid()),
    format('select public.lock_import_run(%L,%L,1)',foreign_import,workspace_b),
    format('select public.prepare_import_route(%L,%L,1,%L,%L,%L,%L,1)',foreign_import,workspace_b,foreign_account,gen_random_uuid(),'Synthetic foreign','EUR'),
    format('select public.ingest_import_row(%L,%L,1,%L,%L::jsonb)',foreign_import,workspace_b,foreign_account,'{}'),
    format('select public.finish_import_run(%L,%L,1)',foreign_import,workspace_b),
    format('select public.rename_trusted_artifact(%L,%L)',foreign_artifact,'Attempted foreign change'),
    format('select public.save_generated_artifact_version(%L,%L,%L::jsonb,%L,null)',foreign_artifact,'return {};','{"kind":"spending_explorer","runtime":"quickjs-calculator-v1","sdk":[]}','validated'),
    format('select public.confirm_recurring_series(%L,%L,%L,%L,100,100,3,90,array[%L,%L,%L]::uuid[])',foreign_account,'Synthetic foreign','monthly','EUR',foreign_transaction,gen_random_uuid(),gen_random_uuid()),
    format('select public.decline_recurring_series(%L,%L,%L,%L,100,100,3,90,array[%L,%L,%L]::uuid[])',foreign_account,'Synthetic foreign','monthly','EUR',foreign_transaction,gen_random_uuid(),gen_random_uuid()),
    format('select public.edit_assumption(%L,1,%L::jsonb,%L)',foreign_assumption,'{"enabled":false}',gen_random_uuid()),
    format('select public.edit_spending_plan(%L,1,%L::jsonb,%L)',foreign_plan,'{"enabled":false}',gen_random_uuid()),
    format('select public.undo_planning_event(%L,1)',foreign_event),
    format('select public.resolve_transaction_classification(%L,0,%L,false)',foreign_transaction,'ordinary'),
    format('select public.undo_transaction_classification(%L,0)',md5('correction_events'||workspace_b)::uuid),
    format('select public.recount_import_progress(%L)',foreign_import),
    format('select public.create_manual_transaction(%L,%L,%L,%L,%L,null,%L,%L)',foreign_account,'2026-10-01','Synthetic foreign','100','posted','',gen_random_uuid()),
    format('select public.undo_manual_transaction(%L,0,0)',md5('manual_transaction_entries'||workspace_b)::uuid),
    format('select public.restore_manual_transaction(%L,0)',md5('manual_transaction_entries'||workspace_b)::uuid),
    format('select public.bulk_edit_transactions(%L::jsonb,%L::jsonb,%L)',jsonb_build_array(jsonb_build_object('id',foreign_transaction,'version',0)),'{"tags":["synthetic"]}',gen_random_uuid()),
    format('select public.undo_transaction_metadata(%L,0)',md5('correction_events'||workspace_b)::uuid),
    format('select public.undo_transaction_batch(%L,%L::jsonb)',md5('transaction_batches'||workspace_b)::uuid,'[]'),
    format('select public.split_transaction(%L,0,%L::jsonb,%L)',foreign_transaction,'[{"amount_minor":"50","category_id":null,"note":""},{"amount_minor":"50","category_id":null,"note":""}]',gen_random_uuid()),
    format('select public.undo_transaction_splits(%L,0)',md5('transaction_split_sets'||workspace_b)::uuid),
    format('select public.claim_scheduled_summary(%L,%L,%L)',workspace_b,'weekly','2026-10-01'),
    format('select public.reserve_goal_funds(%L,%L,%L,1,%L)',foreign_goal,foreign_account,'100',gen_random_uuid()),
    format('select public.undo_goal_reservation(%L,1)',md5('goal_reservation_events'||workspace_b)::uuid),
    format('select public.edit_goal_plan(%L,0,%L::jsonb,%L)',foreign_goal,'{"status":"paused"}',gen_random_uuid()),
    format('select public.undo_goal_plan(%L,0)',md5('goal_events'||workspace_b)::uuid),
    format('select public.edit_wealth_item(%L,1,%L::jsonb,true,%L)',md5('wealth_items'||workspace_b)::uuid,'{}',gen_random_uuid()),
    format('select public.undo_wealth_event(%L,1)',md5('wealth_events'||workspace_b)::uuid),
    format('select public.edit_forecast_preferences(%L,%L::jsonb,1,%L)',workspace_b,'{"currency_code":"EUR","safety_buffer_minor":"0","daily_spending_minor":"0","uncertainty_bps":1000}',gen_random_uuid()),
    format('select public.undo_forecast_preferences(%L,1)',md5('forecast_preference_events'||workspace_b)::uuid),
    format('select public.cancel_financial_review(%L)',md5('background_jobs'||workspace_b)::uuid),
    format('select public.start_financial_review(%L,%L)',gen_random_uuid(),md5('chat_requests'||workspace_b)::uuid),
    format('select public.edit_money_metadata(%L,%L,1,%L::jsonb,%L)','account',foreign_account,'{"name":"Foreign rename"}',gen_random_uuid()),
    format('select public.edit_money_metadata(%L,%L,1,%L::jsonb,%L)','transaction_view',md5('transaction_views'||workspace_b)::uuid,'{"removed":true}',gen_random_uuid()),
    format('select public.undo_money_metadata(%L,1,%L)',md5('money_metadata_events'||workspace_b)::uuid,gen_random_uuid()),
    format('select public.edit_scenario_record(%L,%L,1,%L::jsonb,%L)','scenario',md5('scenarios'||workspace_b)::uuid,'{"name":"Foreign"}',gen_random_uuid()),
    format('select public.undo_scenario_record(%L,1)',md5('scenario_events'||workspace_b)::uuid),
    format('select public.begin_artifact_generation(%L,%L,%L,%L)',gen_random_uuid(),'calculator','Synthetic request',foreign_artifact),
    format('select public.finish_artifact_generation(%L,%L,%L::jsonb)',md5('artifact_generation_requests'||workspace_b)::uuid,'completed','{}'),
    format('select public.cancel_artifact_generation(%L)',md5('artifact_generation_requests'||workspace_b)::uuid),
    format('select public.link_transactions(%L,%L,0,%L,0,null,%L::jsonb,%L)','transfer',foreign_transaction,gen_random_uuid(),'[]',gen_random_uuid()),
    format('select public.undo_transaction_link(%L,%L::jsonb)',md5('transaction_links'||workspace_b)::uuid,'[]'),
    format('select public.finish_financial_review(%L,%L,%L,%L,%L::jsonb,false)',md5('background_jobs'||workspace_b)::uuid,workspace_b,'Synthetic','Synthetic','{}'),
    format('select public.start_chat_request(%L,%L,%L,%L::jsonb)',gen_random_uuid(),md5('conversations'||workspace_b)::uuid,'Synthetic request','{}'),
    format('select public.chat_set_category(%L,%L,%L)',md5('chat_requests'||workspace_b)::uuid,foreign_transaction,'Synthetic'),
    format('select public.cancel_chat_request(%L)',md5('chat_requests'||workspace_b)::uuid),
    format('select public.finish_chat_request(%L,%L,%L)',md5('chat_requests'||workspace_b)::uuid,'completed','Synthetic answer')
  ] loop
    begin
      execute call;
      raise exception 'Foreign-target RPC succeeded: %',split_part(call,'(',1) using errcode='ZX001';
    exception when insufficient_privilege or no_data_found or sqlstate 'P0002' then null; end;
  end loop;
  execute 'reset role';
end;
$$;
