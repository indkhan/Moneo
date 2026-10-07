-- A user request suppresses publication immediately; only a settled worker or
-- runtime reconciliation may acknowledge application termination.
create or replace function public.cancel_financial_review(p_job_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare job public.background_jobs%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  select * into job from public.background_jobs where id=p_job_id and kind='financial_review' and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Review job not found' using errcode='P0002'; end if;
  if job.status in ('queued','running') then
    update public.background_jobs set cancel_requested=true,stage='cancel_requested',updated_at=now() where id=job.id;
    return 'cancel_requested';
  end if;
  return job.status;
end;
$$;
revoke all on function public.cancel_financial_review(uuid) from public,anon;
grant execute on function public.cancel_financial_review(uuid) to authenticated;

-- Preserve explicit uncertainty when a canceled runtime still has a running step.
create or replace function public.fail_financial_review(p_job_id uuid,p_workspace_id uuid,p_run_id text,p_stage text,p_error text)
returns text language plpgsql security definer set search_path='' as $$
declare job public.background_jobs%rowtype;
begin
  if p_run_id is null or length(btrim(p_run_id)) not between 1 and 200 or p_stage is null or length(p_stage) not between 1 and 100
    or p_error is null or length(p_error)>2000 then raise exception 'Invalid review failure' using errcode='22023'; end if;
  select * into job from public.background_jobs where id=p_job_id and workspace_id=p_workspace_id and kind='financial_review' for update;
  if not found then raise exception 'Review job not found' using errcode='P0002'; end if;
  if job.status in ('completed','canceled','failed') or (job.workflow_run_id is not null and job.workflow_run_id<>p_run_id) then return job.status; end if;
  update public.background_jobs set status=case when cancel_requested then 'canceled' else 'failed' end,
    stage=case when cancel_requested and p_stage<>'cancellation_unconfirmed' then 'canceled' else p_stage end,error=case when cancel_requested then null else p_error end,
    workflow_run_id=coalesce(workflow_run_id,p_run_id),dispatched_at=coalesce(dispatched_at,now()),updated_at=now() where id=job.id;
  return case when job.cancel_requested then 'canceled' else 'failed' end;
end;
$$;
revoke all on function public.fail_financial_review(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.fail_financial_review(uuid,uuid,text,text,text) to service_role;

