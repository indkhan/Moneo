do $$
declare actor uuid:=gen_random_uuid(); workspace uuid; job uuid; canceled_job uuid; revoked_job uuid; scheduled_job uuid; planning_job uuid;
begin
  insert into auth.users(id,email) values(actor,'qa-'||actor||'@example.invalid');
  select id into strict workspace from public.workspaces where owner_id=actor;
  insert into public.background_jobs(workspace_id,kind) values(workspace,'financial_review') returning id into job;
  insert into public.background_jobs(workspace_id,kind) values(workspace,'financial_review') returning id into canceled_job;
  insert into public.background_jobs(workspace_id,kind) values(workspace,'financial_review') returning id into revoked_job;
  insert into public.background_jobs(workspace_id,kind) values(workspace,'financial_review') returning id into scheduled_job;
  insert into public.background_jobs(workspace_id,kind) values(workspace,'financial_review') returning id into planning_job;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  execute 'set local role authenticated';
  if public.cancel_financial_review(canceled_job)<>'canceled' then raise exception 'Review cancellation not immediately effective'; end if;
  begin
    perform public.finish_financial_review(job,workspace,'Private review','Synthetic body','{}',false);
    raise exception 'Authenticated caller finished privileged review' using errcode='ZX001';
  exception when insufficient_privilege then null; end;
  execute 'set local role service_role';
  if public.finish_financial_review(canceled_job,workspace,'Private review','Synthetic body','{}',false)<>'canceled' then raise exception 'Canceled review completed'; end if;
  if public.finish_financial_review(job,workspace,'Private review','Original exact evidence','{}',false)<>'completed' then raise exception 'Review not completed'; end if;
  perform public.finish_financial_review(job,workspace,'Another title','Replacement body','{"changed":true}',false);
  execute 'reset role';
  if (select count(*) from public.saved_analyses where job_id=job)<>1 or not exists(select 1 from public.saved_analyses where job_id=job and body='Original exact evidence') then raise exception 'Review retry replaced historical evidence'; end if;
  if exists(select 1 from public.saved_analyses where job_id=canceled_job) then raise exception 'Cancellation wrote analysis'; end if;
  insert into public.workspace_settings(workspace_id,ai_data_scopes,summary_cadence) values(workspace,array['accounts'],'weekly');
  execute 'set local role service_role';
  if public.finish_financial_review(revoked_job,workspace,'Private review','Synthetic body','{}',false)<>'canceled' then raise exception 'Revoked scope wrote review'; end if;
  execute 'reset role';
  update public.workspace_settings set ai_data_scopes=array['accounts','transactions'],summary_cadence='none' where workspace_id=workspace;
  insert into public.summary_runs(workspace_id,job_id,period_start,cadence) values(workspace,scheduled_job,'2026-10-01','weekly');
  execute 'set local role service_role';
  if public.finish_financial_review(planning_job,workspace,'Private review','Synthetic body','{"planning":{"goals":[]}}',false)<>'canceled' then raise exception 'Revoked planning scope wrote review'; end if;
  if public.finish_financial_review(scheduled_job,workspace,'Private review','Synthetic body','{}',false)<>'canceled' then raise exception 'Disabled cadence bypassed through unscheduled flag'; end if;
  execute 'reset role';
  if exists(select 1 from public.saved_analyses where job_id in(revoked_job,scheduled_job,planning_job)) then raise exception 'Permissions/schedule cancellation wrote review'; end if;
end;
$$;
