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
