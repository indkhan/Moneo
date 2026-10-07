-- Unattended recovery reuses durable claims, regardless of origin/current cadence.
do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; scheduled_job uuid; manual_job uuid; period date; run text:='wrun_recovery_'||gen_random_uuid();
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.workspace_settings(workspace_id,summary_cadence,summary_time,timezone,ai_data_scopes)
    values(workspace,'weekly','00:00','UTC',array['accounts','transactions'])
    on conflict(workspace_id) do update set summary_cadence='weekly',summary_time='00:00',timezone='UTC',ai_data_scopes=array['accounts','transactions'];
  period:=date_trunc('week',now() at time zone 'UTC')::date;
  execute 'set local role service_role';
  scheduled_job:=public.claim_scheduled_summary(workspace,'weekly',period);
  if scheduled_job is null then raise exception 'Synthetic scheduled claim unavailable'; end if;
  if public.claim_scheduled_summary(workspace,'weekly',period) is not null then raise exception 'Scheduled claim recreated during recovery'; end if;
  if not exists(select 1 from public.background_jobs where id=scheduled_job and status='queued' and workflow_run_id is null) then raise exception 'Interrupted enqueue claim missing'; end if;
  if not exists(select 1 from public.summary_runs where job_id=scheduled_job and workspace_id=workspace and cadence='weekly') then raise exception 'Scheduled identity lost'; end if;
  if not public.register_financial_review_run(scheduled_job,workspace,run) then raise exception 'Orphan recovery could not elect a run'; end if;
  if public.register_financial_review_run(scheduled_job,workspace,run||'_duplicate') then raise exception 'Recovery allowed duplicate useful work'; end if;
  execute 'reset role';
  update public.workspace_settings set summary_cadence='none' where workspace_id=workspace;
  execute 'set local role service_role';
  if public.finish_financial_review(scheduled_job,workspace,'Synthetic recovery','Synthetic body','{}',true)<>'canceled' then raise exception 'Recovered scheduled run ignored disabled cadence'; end if;
  if public.fail_financial_review(scheduled_job,workspace,run,'runtime_reconciliation','Lost cleanup')<>'canceled' then raise exception 'Reconciliation overwrote cancellation'; end if;
  execute 'reset role';
  insert into public.background_jobs(workspace_id,kind) values(workspace,'financial_review') returning id into manual_job;
  execute 'set local role service_role';
  if not public.register_financial_review_run(manual_job,workspace,run||'_manual') then raise exception 'Manual orphan unavailable with scheduling disabled'; end if;
  if public.fail_financial_review(manual_job,workspace,run||'_manual','runtime_reconciliation','Workflow missing after receipt grace')<>'failed' then raise exception 'Missing runtime failed to converge'; end if;
  if public.finish_financial_review(manual_job,workspace,'Late','Late body','{}',false)<>'failed' then raise exception 'Recovered failure published late'; end if;
  execute 'reset role';
  if exists(select 1 from public.saved_analyses where job_id in(scheduled_job,manual_job)) then raise exception 'Recovery published a terminal job'; end if;
end;
$$;
