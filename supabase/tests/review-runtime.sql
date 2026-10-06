do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; job uuid; canceled_job uuid; failed_job uuid; run text:='wrun_synthetic_'||gen_random_uuid();
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.background_jobs(workspace_id,kind) values(workspace,'financial_review') returning id into job;
  insert into public.background_jobs(workspace_id,kind) values(workspace,'financial_review') returning id into canceled_job;
  insert into public.background_jobs(workspace_id,kind) values(workspace,'financial_review') returning id into failed_job;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  begin
    perform public.register_financial_review_run(job,workspace,run);
    raise exception 'Authenticated caller registered privileged run' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  begin
    perform public.fail_financial_review(job,workspace,run,'evidence','Synthetic error');
    raise exception 'Authenticated caller finalized privileged run' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  execute 'set local role service_role';
  if not public.register_financial_review_run(job,workspace,run) then raise exception 'Initial run not registered'; end if;
  if not public.register_financial_review_run(job,workspace,run) then raise exception 'Receipt replay not idempotent'; end if;
  if public.register_financial_review_run(job,workspace,run||'_duplicate') then raise exception 'Duplicate run elected'; end if;
  if public.fail_financial_review(job,workspace,run||'_duplicate','evidence','Synthetic duplicate error')<>'queued' then raise exception 'Losing run failed winner'; end if;
  begin
    perform public.register_financial_review_run(job,gen_random_uuid(),run);
    raise exception 'Foreign workspace accepted' using errcode='ZX001';
  exception when no_data_found then null; end;
  if public.finish_financial_review(job,workspace,'Synthetic','Synthetic body','{}',false)<>'completed' then raise exception 'Review did not complete'; end if;
  if public.fail_financial_review(job,workspace,run,'saving_review','Lost response')<>'completed' then raise exception 'Failure overwrote publication'; end if;
  if public.finish_financial_review(job,workspace,'Replacement','Replacement body','{}',false)<>'completed' then raise exception 'Publication replay failed'; end if;
  if not public.register_financial_review_run(canceled_job,workspace,run||'_cancel') then raise exception 'Canceled test not registered'; end if;
  execute 'set local role authenticated';
  perform public.cancel_financial_review(canceled_job);
  execute 'set local role service_role';
  if public.fail_financial_review(canceled_job,workspace,run||'_cancel','writing_review','Late failure')<>'canceled' then raise exception 'Failure overwrote cancel'; end if;
  if public.finish_financial_review(canceled_job,workspace,'Late','Late body','{}',false)<>'canceled' then raise exception 'Canceled review published'; end if;
  if public.fail_financial_review(failed_job,workspace,run||'_failed','gathering_evidence','Exhausted')<>'failed' then raise exception 'Unacknowledged run not finalized'; end if;
  if public.fail_financial_review(failed_job,workspace,run||'_failed','gathering_evidence','Exhausted')<>'failed' then raise exception 'Failure replay failed'; end if;
  if public.finish_financial_review(failed_job,workspace,'Late','Late body','{}',false)<>'failed' then raise exception 'Failed job published'; end if;
  execute 'reset role';
  if (select count(*) from public.saved_analyses where job_id=job)<>1 or not exists(select 1 from public.saved_analyses where job_id=job and body='Synthetic body') then raise exception 'Saved analysis duplicated or replaced'; end if;
  if exists(select 1 from public.saved_analyses where job_id in(canceled_job,failed_job)) then raise exception 'Terminal job published'; end if;
  if not exists(select 1 from public.background_jobs where id=job and workflow_run_id=run and dispatched_at is not null) then raise exception 'Run receipt missing'; end if;
end;
$$;
