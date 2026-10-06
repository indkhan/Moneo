alter table public.background_jobs add column workflow_run_id text;
alter table public.background_jobs add column dispatched_at timestamptz;
alter table public.background_jobs add constraint background_jobs_workflow_run_key unique(workflow_run_id);

-- start() has no caller-provided idempotency key. Elect one actual run before any
-- evidence/model work; both dispatch acknowledgement and worker replay use this receipt.
create function public.register_financial_review_run(p_job_id uuid,p_workspace_id uuid,p_run_id text)
returns boolean language plpgsql security definer set search_path='' as $$
declare job public.background_jobs%rowtype;
begin
  if p_run_id is null or length(btrim(p_run_id)) not between 1 and 200 then raise exception 'Invalid review runtime identity' using errcode='22023'; end if;
  select * into job from public.background_jobs where id=p_job_id and workspace_id=p_workspace_id and kind='financial_review' for update;
  if not found then raise exception 'Review job not found' using errcode='P0002'; end if;
  if job.status not in ('queued','running') or job.cancel_requested then return false; end if;
  if job.workflow_run_id is null then
    update public.background_jobs set workflow_run_id=p_run_id,dispatched_at=now(),updated_at=now() where id=job.id;
  elsif job.workflow_run_id<>p_run_id then return false;
  end if;
  return true;
end;
$$;
revoke all on function public.register_financial_review_run(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.register_financial_review_run(uuid,uuid,text) to service_role;

create function public.fail_financial_review(p_job_id uuid,p_workspace_id uuid,p_run_id text,p_stage text,p_error text)
returns text language plpgsql security definer set search_path='' as $$
declare job public.background_jobs%rowtype;
begin
  if p_run_id is null or length(btrim(p_run_id)) not between 1 and 200 or p_stage is null or length(p_stage) not between 1 and 100
    or p_error is null or length(p_error)>2000 then raise exception 'Invalid review failure' using errcode='22023'; end if;
  select * into job from public.background_jobs where id=p_job_id and workspace_id=p_workspace_id and kind='financial_review' for update;
  if not found then raise exception 'Review job not found' using errcode='P0002'; end if;
  if job.status in ('completed','canceled','failed') or (job.workflow_run_id is not null and job.workflow_run_id<>p_run_id) then return job.status; end if;
  update public.background_jobs set status=case when cancel_requested then 'canceled' else 'failed' end,
    stage=case when cancel_requested then 'canceled' else p_stage end,error=case when cancel_requested then null else p_error end,
    workflow_run_id=coalesce(workflow_run_id,p_run_id),dispatched_at=coalesce(dispatched_at,now()),updated_at=now() where id=job.id;
  return case when job.cancel_requested then 'canceled' else 'failed' end;
end;
$$;
revoke all on function public.fail_financial_review(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.fail_financial_review(uuid,uuid,text,text,text) to service_role;
