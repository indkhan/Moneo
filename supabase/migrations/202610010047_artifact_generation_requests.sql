create table public.artifact_generation_requests (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  artifact_id uuid references public.artifacts(id) on delete cascade,
  purpose text not null check(purpose in ('proposal','calculator')),
  description text not null check(length(btrim(description)) between 1 and 500),
  status text not null default 'queued' check(status in ('queued','running','completed','failed','canceled')),
  result jsonb check(result is null or (jsonb_typeof(result)='object' and octet_length(result::text)<=65536)),
  error text check(error is null or length(error)<=2000),
  usage jsonb check(usage is null or (jsonb_typeof(usage)='object' and octet_length(usage::text)<=2000)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check((purpose='calculator' and artifact_id is not null) or (purpose='proposal' and artifact_id is null)),
  check((status='completed' and result is not null and error is null) or (status<>'completed' and result is null))
);
create index artifact_generation_requests_workspace_created_idx on public.artifact_generation_requests(workspace_id,created_at desc);
alter table public.artifact_generation_requests enable row level security;
create policy own_artifact_generation_requests on public.artifact_generation_requests for select to authenticated using(public.owns_workspace(workspace_id));
revoke all on public.artifact_generation_requests from public,anon,authenticated;
grant select on public.artifact_generation_requests to authenticated;
grant all on public.artifact_generation_requests to service_role;

create function public.begin_artifact_generation(p_request_id uuid,p_purpose text,p_description text,p_artifact_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare workspace uuid; receipt public.artifact_generation_requests%rowtype; inserted boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_request_id is null or p_purpose is null or p_purpose not in ('proposal','calculator') or p_description is null or length(btrim(p_description)) not between 1 and 500
    or (p_purpose='calculator' and p_artifact_id is null) or (p_purpose='proposal' and p_artifact_id is not null) then raise exception 'Invalid generation request' using errcode='22023'; end if;
  select id into workspace from public.workspaces where owner_id=auth.uid();
  if workspace is null then raise exception 'Workspace not found' using errcode='P0002'; end if;
  if p_purpose='calculator' and not exists(select 1 from public.artifacts where id=p_artifact_id and workspace_id=workspace and active_version_id is not null) then
    raise exception 'Artifact not found' using errcode='P0002'; end if;
  insert into public.artifact_generation_requests(id,workspace_id,artifact_id,purpose,description,status)
    values(p_request_id,workspace,p_artifact_id,p_purpose,btrim(p_description),'running') on conflict(id) do nothing;
  inserted:=found;
  select * into receipt from public.artifact_generation_requests where id=p_request_id for update;
  if receipt.workspace_id<>workspace then raise exception 'Generation request not found' using errcode='P0002'; end if;
  if receipt.purpose is distinct from p_purpose or receipt.description is distinct from btrim(p_description) or receipt.artifact_id is distinct from p_artifact_id then
    raise exception 'Generation request identity has different input' using errcode='22023'; end if;
  return jsonb_build_object('started',inserted,'status',receipt.status,'result',receipt.result,'error',receipt.error);
end;
$$;

create function public.finish_artifact_generation(p_request_id uuid,p_status text,p_result jsonb default null,p_error text default null,p_usage jsonb default null)
returns text language plpgsql security definer set search_path='' as $$
declare receipt public.artifact_generation_requests%rowtype; token jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_request_id is null or p_status is null or p_status not in ('completed','failed')
    or (p_status='completed' and (p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>65536 or p_error is not null))
    or (p_status='failed' and (p_result is not null or p_error is null or length(btrim(p_error)) not between 1 and 2000)) then
    raise exception 'Invalid generation result' using errcode='22023'; end if;
  if p_usage is not null then
    if jsonb_typeof(p_usage)<>'object' or octet_length(p_usage::text)>2000 or jsonb_typeof(p_usage->'model_id') is distinct from 'string'
      or length(p_usage->>'model_id') not between 1 and 200 or p_usage-array['model_id','input_tokens','output_tokens','total_tokens']<>'{}'::jsonb then
      raise exception 'Invalid reported usage' using errcode='22023'; end if;
    for token in select value from jsonb_each(p_usage-'model_id') loop
      if jsonb_typeof(token)<>'null' and (jsonb_typeof(token)<>'number' or token::text !~ '^\d+$') then raise exception 'Invalid reported token count' using errcode='22023'; end if;
      if jsonb_typeof(token)='number' and token::text::numeric>9007199254740991 then raise exception 'Unsafe reported token count' using errcode='22023'; end if;
    end loop;
  end if;
  select * into receipt from public.artifact_generation_requests where id=p_request_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Generation request not found' using errcode='P0002'; end if;
  if receipt.status in ('completed','failed','canceled') then return receipt.status; end if;
  update public.artifact_generation_requests set status=p_status,result=p_result,error=p_error,usage=p_usage,updated_at=now() where id=receipt.id;
  return p_status;
end;
$$;

create function public.cancel_artifact_generation(p_request_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare receipt public.artifact_generation_requests%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if p_request_id is null then raise exception 'Invalid generation request' using errcode='22023'; end if;
  select * into receipt from public.artifact_generation_requests where id=p_request_id and public.owns_workspace(workspace_id) for update;
  if not found then raise exception 'Generation request not found' using errcode='P0002'; end if;
  if receipt.status in ('queued','running') then
    update public.artifact_generation_requests set status='canceled',result=null,error=null,updated_at=now() where id=receipt.id;
    return 'canceled';
  end if;
  return receipt.status;
end;
$$;
revoke all on function public.begin_artifact_generation(uuid,text,text,uuid),public.finish_artifact_generation(uuid,text,jsonb,text,jsonb),public.cancel_artifact_generation(uuid) from public,anon;
grant execute on function public.begin_artifact_generation(uuid,text,text,uuid),public.finish_artifact_generation(uuid,text,jsonb,text,jsonb),public.cancel_artifact_generation(uuid) to authenticated;
