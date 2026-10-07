-- Source coverage may use imports in addition to accepted-ledger evidence.
-- Retain the existing settings/workspace lock order and atomic publication.
create or replace function public.finish_financial_review(p_job_id uuid,p_workspace_id uuid,p_title text,p_body text,p_evidence jsonb,p_scheduled boolean default false)
returns text language plpgsql security definer set search_path='' as $$
declare job public.background_jobs%rowtype; preferences public.workspace_settings%rowtype; scheduled boolean;
begin
  if p_job_id is null or p_workspace_id is null or p_scheduled is null or p_title is null or length(btrim(p_title)) not between 1 and 200
    or p_body is null or length(btrim(p_body)) not between 1 and 20000 or p_evidence is null or jsonb_typeof(p_evidence)<>'object'
    or octet_length(p_evidence::text)>1048576 then raise exception 'Invalid financial review completion' using errcode='22023'; end if;
  select * into job from public.background_jobs where id=p_job_id and workspace_id=p_workspace_id and kind='financial_review' for update;
  if not found then raise exception 'Review job not found' using errcode='P0002'; end if;
  if job.status='completed' then return job.status; end if;
  if job.status='canceled' or job.cancel_requested then
    update public.background_jobs set status='canceled',stage='canceled',updated_at=now() where id=job.id;
    return 'canceled';
  end if;
  if job.status='failed' then return job.status; end if;
  perform id from public.workspaces where id=job.workspace_id for share;
  -- Read the committed preference version without a second lock order against direct row updates.
  select * into preferences from public.workspace_settings where workspace_id=job.workspace_id;
  if found and (not preferences.ai_data_scopes @> array['accounts','transactions']::text[] or
    (jsonb_typeof(p_evidence->'planning')='object' and (p_evidence->'planning')-'unavailable'<>'{}'::jsonb and not preferences.ai_data_scopes @> array['planning']::text[]) or
    (jsonb_typeof(p_evidence->'sourceCoverage'->'importStatuses')='object' and not preferences.ai_data_scopes @> array['imports']::text[])) then
    update public.background_jobs set status='canceled',stage='permissions_changed',cancel_requested=true,updated_at=now() where id=job.id;
    return 'canceled';
  end if;
  select exists(select 1 from public.summary_runs where job_id=job.id and workspace_id=job.workspace_id) into scheduled;
  if p_scheduled and not scheduled then raise exception 'Scheduled review receipt not found' using errcode='22023'; end if;
  if scheduled and (preferences.summary_cadence is null or preferences.summary_cadence='none' or
    exists(select 1 from public.summary_runs where job_id=job.id and (workspace_id<>job.workspace_id or cadence<>preferences.summary_cadence))) then
    update public.background_jobs set status='canceled',stage='schedule_changed',cancel_requested=true,updated_at=now() where id=job.id;
    return 'canceled';
  end if;
  if exists(select 1 from public.saved_analyses where job_id=job.id and workspace_id<>job.workspace_id) then raise exception 'Review evidence workspace mismatch' using errcode='22023'; end if;
  insert into public.saved_analyses(workspace_id,job_id,title,body,evidence)
    values(job.workspace_id,job.id,btrim(p_title),btrim(p_body),p_evidence) on conflict(job_id) do nothing;
  update public.background_jobs set status='completed',stage='completed',error=null,updated_at=now() where id=job.id;
  return 'completed';
end;
$$;
revoke all on function public.finish_financial_review(uuid,uuid,text,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.finish_financial_review(uuid,uuid,text,text,jsonb,boolean) to service_role;
