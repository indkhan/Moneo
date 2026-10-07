alter table public.background_jobs add column review_request jsonb;
alter table public.background_jobs add column review_progress jsonb;
alter table public.background_jobs add constraint background_jobs_review_request_check check
  (review_request is null or (jsonb_typeof(review_request)='object' and octet_length(review_request::text)<=65536));
alter table public.background_jobs add constraint background_jobs_review_progress_check check
  (review_progress is null or (jsonb_typeof(review_progress)='object' and octet_length(review_progress::text)<=262144));

create function public.freeze_financial_investigation_request() returns trigger
language plpgsql set search_path='' as $$
begin
  if old.review_request is not null and new.review_request is distinct from old.review_request then
    raise exception 'Investigation request is immutable' using errcode='55000';
  end if;
  return new;
end;
$$;
revoke all on function public.freeze_financial_investigation_request() from public,anon,authenticated;
create trigger background_jobs_frozen_review_request before update on public.background_jobs
  for each row execute function public.freeze_financial_investigation_request();

-- This creates only a read-only investigation. It never authorizes a canonical financial edit.
-- The application also parses the complete strict query schema before dispatch and every replay.
create function public.start_financial_investigation(p_request_id uuid,p_specification jsonb,p_chat_request_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare workspace uuid; parent public.chat_requests%rowtype; preferences public.workspace_settings%rowtype; job public.background_jobs%rowtype; inserted boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_request_id is null or not coalesce(jsonb_typeof(p_specification)='object'
    and octet_length(p_specification::text)<=65536 and p_specification->>'version'='1'
    and jsonb_typeof(p_specification->'question')='string' and length(btrim(p_specification->>'question')) between 1 and 2000
    and jsonb_typeof(p_specification->'query')='object' and jsonb_typeof(p_specification->'budget')='object'
    and jsonb_typeof(p_specification->'includePlanning')='boolean' and p_specification->>'output' in ('answer','report')
    and (p_specification->'budget'->>'maxQueries')::integer between 1 and 12
    and (p_specification->'budget'->>'maxSupportRecords')::integer between 1 and 200
    and (p_specification->'budget'->>'maxOutputTokens')::integer between 256 and 8000
    and (p_specification->'budget'->>'maxDurationMs')::integer between 5000 and 180000,false) then
    raise exception 'Invalid bounded investigation request' using errcode='22023';
  end if;
  select id into workspace from public.workspaces where owner_id=auth.uid();
  if workspace is null then raise exception 'Workspace not found' using errcode='P0002'; end if;
  if p_chat_request_id is not null then
    select * into parent from public.chat_requests where id=p_chat_request_id and workspace_id=workspace for update;
    if not found then raise exception 'Chat request not found' using errcode='P0002'; end if;
    if parent.status<>'running' then raise exception 'Chat request is no longer active' using errcode='57014'; end if;
    if btrim(parent.message) is distinct from btrim(p_specification->>'question') then
      raise exception 'Investigation must retain the current question' using errcode='22023';
    end if;
  end if;
  perform id from public.workspaces where id=workspace for share;
  select * into preferences from public.workspace_settings where workspace_id=workspace;
  if found and (not preferences.ai_data_scopes @> array['accounts','transactions']::text[]
    or (p_specification->>'includePlanning')::boolean and not preferences.ai_data_scopes @> array['planning']::text[]) then
    raise exception 'Investigation evidence access is disabled' using errcode='42501';
  end if;
  insert into public.background_jobs(workspace_id,kind,request_id,chat_request_id,review_request)
    values(workspace,'financial_review',p_request_id,p_chat_request_id,p_specification)
    on conflict(workspace_id,request_id) do nothing;
  inserted:=found;
  select * into strict job from public.background_jobs where workspace_id=workspace and request_id=p_request_id for update;
  if job.kind<>'financial_review' or job.chat_request_id is distinct from p_chat_request_id or job.review_request is distinct from p_specification then
    raise exception 'Investigation identity has different input' using errcode='22023';
  end if;
  return jsonb_build_object('jobId',job.id,'status',job.status,'started',inserted);
end;
$$;
revoke all on function public.start_financial_investigation(uuid,jsonb,uuid) from public,anon;
grant execute on function public.start_financial_investigation(uuid,jsonb,uuid) to authenticated;

create function public.checkpoint_financial_investigation(p_job_id uuid,p_workspace_id uuid,p_run_id text,p_progress jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare job public.background_jobs%rowtype; specification jsonb; old_progress jsonb;
begin
  select * into job from public.background_jobs where id=p_job_id and workspace_id=p_workspace_id and kind='financial_review' for update;
  if not found then raise exception 'Review job not found' using errcode='P0002'; end if;
  if job.workflow_run_id is distinct from p_run_id or p_run_id is null or job.status not in ('queued','running') or job.cancel_requested then return false; end if;
  specification:=coalesce(job.review_request,p_progress->'request'); old_progress:=job.review_progress;
  if not coalesce(jsonb_typeof(p_progress)='object' and octet_length(p_progress::text)<=262144
    and p_progress->>'version'='1' and p_progress->'request'=specification
    and jsonb_typeof(specification)='object' and specification->>'version'='1'
    and jsonb_typeof(p_progress->'queries')='array' and jsonb_typeof(p_progress->'limitations')='array'
    and jsonb_typeof(p_progress->'startedAt')='number' and (p_progress->>'startedAt')::numeric>0
    and (p_progress->>'supportRecords')::integer between 0 and (specification->'budget'->>'maxSupportRecords')::integer
    and jsonb_array_length(p_progress->'queries')<=(specification->'budget'->>'maxQueries')::integer,false) then
    raise exception 'Invalid investigation progress' using errcode='22023';
  end if;
  if old_progress is not null and (old_progress->'startedAt' is distinct from p_progress->'startedAt'
    or old_progress->>'synthesisAttempted'='true' and p_progress->>'synthesisAttempted' is distinct from 'true'
    or jsonb_array_length(old_progress->'queries')>jsonb_array_length(p_progress->'queries')
    or (old_progress->>'supportRecords')::integer>(p_progress->>'supportRecords')::integer
    or exists(select 1 from jsonb_array_elements(old_progress->'queries') with ordinality as entry(value,position)
      where entry.value->'query' is distinct from p_progress->'queries'->(entry.position::integer-1)->'query'
        or entry.value->>'status'='completed' and entry.value is distinct from p_progress->'queries'->(entry.position::integer-1))) then
    raise exception 'Investigation progress cannot reset spent budgets or completed evidence' using errcode='22023';
  end if;
  update public.background_jobs set review_request=specification,review_progress=p_progress,updated_at=now() where id=job.id;
  return true;
end;
$$;
revoke all on function public.checkpoint_financial_investigation(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.checkpoint_financial_investigation(uuid,uuid,text,jsonb) to service_role;

-- A single row-locked claim, rather than two readers checking the same old flag,
-- reserves the model budget even when durable invocations overlap.
create function public.reserve_financial_investigation_synthesis(p_job_id uuid,p_workspace_id uuid,p_run_id text,p_progress jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare job public.background_jobs%rowtype;
begin
  select * into job from public.background_jobs where id=p_job_id and workspace_id=p_workspace_id and kind='financial_review' for update;
  if not found then raise exception 'Review job not found' using errcode='P0002'; end if;
  if job.workflow_run_id is distinct from p_run_id or p_run_id is null or job.status not in ('queued','running') or job.cancel_requested
    or job.review_progress->>'synthesisAttempted'='true' then return false; end if;
  if p_progress->>'synthesisAttempted' is distinct from 'true' then raise exception 'Invalid synthesis reservation' using errcode='22023'; end if;
  return public.checkpoint_financial_investigation(p_job_id,p_workspace_id,p_run_id,p_progress);
end;
$$;
revoke all on function public.reserve_financial_investigation_synthesis(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_financial_investigation_synthesis(uuid,uuid,text,jsonb) to service_role;

-- Only the current run can publish its exact recorded progress. Every referenced
-- receipt must belong to this workspace and remain readable at the atomic save.
create function public.finish_financial_investigation(p_job_id uuid,p_workspace_id uuid,p_run_id text,p_title text,p_body text,p_evidence jsonb,p_scheduled boolean default false)
returns text language plpgsql security definer set search_path='' as $$
declare job public.background_jobs%rowtype; current_scopes text[]; ids uuid[]; recorded_ids uuid[];
begin
  select * into job from public.background_jobs where id=p_job_id and workspace_id=p_workspace_id and kind='financial_review' for update;
  if not found then raise exception 'Review job not found' using errcode='P0002'; end if;
  if p_run_id is null or job.workflow_run_id is distinct from p_run_id then return 'canceled'; end if;
  if job.status='completed' then return 'completed'; end if;
  if job.status='canceled' or job.cancel_requested then
    return public.finish_financial_review(p_job_id,p_workspace_id,p_title,p_body,p_evidence,p_scheduled);
  end if;
  if job.review_request is null or job.review_progress is null
    or p_evidence->'reviewInvestigation'->'request' is distinct from job.review_request
    or p_evidence->'reviewInvestigation'->'progress' is distinct from job.review_progress
    or jsonb_typeof(p_evidence->'verification'->'receiptIds') is distinct from 'array'
    or jsonb_array_length(p_evidence->'verification'->'receiptIds')>12 then
    raise exception 'Investigation publication must retain its recorded request and progress' using errcode='22023';
  end if;
  select coalesce(array_agg(distinct value::uuid),'{}'::uuid[]) into ids from jsonb_array_elements_text(p_evidence->'verification'->'receiptIds');
  if cardinality(ids)<>jsonb_array_length(p_evidence->'verification'->'receiptIds') then raise exception 'Duplicate publication receipt' using errcode='22023'; end if;
  select coalesce(array_agg(distinct (value->>'receiptId')::uuid),'{}'::uuid[]) into recorded_ids
    from jsonb_array_elements(job.review_progress->'queries') where value->>'status'='completed' and value->>'receiptId' is not null;
  if not(ids @> recorded_ids and recorded_ids @> ids) then raise exception 'Publication receipts differ from retained queries' using errcode='22023'; end if;
  perform id from public.workspaces where id=p_workspace_id for share;
  select ai_data_scopes into current_scopes from public.workspace_settings where workspace_id=p_workspace_id for share;
  if not found then current_scopes:=array['accounts','transactions','planning','imports']::text[]; end if;
  if exists(select 1 from unnest(ids) wanted(id) left join public.financial_evidence_receipts receipt
    on receipt.id=wanted.id and receipt.workspace_id=p_workspace_id where receipt.id is null) then
    raise exception 'Owned retained receipt is unavailable' using errcode='42501';
  end if;
  if exists(select 1 from public.financial_evidence_receipts receipt where receipt.id=any(ids) and receipt.workspace_id=p_workspace_id and not(receipt.scopes <@ current_scopes)) then
    update public.background_jobs set status='canceled',stage='permissions_changed',cancel_requested=true,updated_at=now() where id=job.id;
    return 'canceled';
  end if;
  return public.finish_financial_review(p_job_id,p_workspace_id,p_title,p_body,p_evidence,p_scheduled);
end;
$$;
revoke all on function public.finish_financial_investigation(uuid,uuid,text,text,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.finish_financial_investigation(uuid,uuid,text,text,text,jsonb,boolean) to service_role;
