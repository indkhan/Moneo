alter table public.background_jobs add column request_id uuid;
alter table public.background_jobs add column chat_request_id uuid references public.chat_requests(id) on delete set null;
alter table public.background_jobs add constraint background_jobs_workspace_request_key unique(workspace_id,request_id);

create function public.start_financial_review(p_request_id uuid,p_chat_request_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare workspace uuid; parent public.chat_requests%rowtype; preferences public.workspace_settings%rowtype; job public.background_jobs%rowtype; inserted boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_request_id is null then raise exception 'Invalid review request' using errcode='22023'; end if;
  select id into workspace from public.workspaces where owner_id=auth.uid();
  if workspace is null then raise exception 'Workspace not found' using errcode='P0002'; end if;
  if p_chat_request_id is not null then
    select * into parent from public.chat_requests where id=p_chat_request_id and workspace_id=workspace for update;
    if not found then raise exception 'Chat request not found' using errcode='P0002'; end if;
    if parent.status<>'running' then raise exception 'Chat request is no longer active' using errcode='57014'; end if;
    if btrim(parent.message) !~* '^(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:(?:start|run|create)\s+(?:a\s+)?(?:deep\s+)?financial\s+review|review\s+my\s+finances)[.!?]?$' then
      raise exception 'Current user message does not authorize a persistent review' using errcode='42501'; end if;
  end if;
  perform id from public.workspaces where id=workspace for share;
  select * into preferences from public.workspace_settings where workspace_id=workspace;
  if found and not preferences.ai_data_scopes @> array['accounts','transactions']::text[] then raise exception 'Review evidence access is disabled' using errcode='42501'; end if;
  insert into public.background_jobs(workspace_id,kind,request_id,chat_request_id) values(workspace,'financial_review',p_request_id,p_chat_request_id)
    on conflict(workspace_id,request_id) do nothing;
  inserted:=found;
  select * into strict job from public.background_jobs where workspace_id=workspace and request_id=p_request_id for update;
  if job.kind<>'financial_review' or job.chat_request_id is distinct from p_chat_request_id then raise exception 'Review identity has different input' using errcode='22023'; end if;
  return jsonb_build_object('jobId',job.id,'status',job.status,'started',inserted);
end;
$$;
revoke all on function public.start_financial_review(uuid,uuid) from public,anon;
grant execute on function public.start_financial_review(uuid,uuid) to authenticated;
