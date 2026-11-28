create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  task text not null check (task ~ '^[a-z_]{1,40}$'),
  model_id text not null check (char_length(model_id) between 1 and 200),
  source text not null check (source in ('chatgpt','claude','openai','openrouter','local','unknown')),
  input_tokens bigint check (input_tokens >= 0),
  output_tokens bigint check (output_tokens >= 0),
  reasoning_tokens bigint check (reasoning_tokens >= 0),
  cached_input_tokens bigint check (cached_input_tokens >= 0),
  audio_seconds numeric(12,3) check (audio_seconds >= 0),
  duration_ms integer check (duration_ms >= 0),
  status text not null check (status in ('succeeded','failed','canceled')),
  error_kind text check (char_length(error_kind) between 1 and 100),
  conversation_id uuid,
  job_id uuid,
  agent_run_id uuid
);
create index ai_usage_workspace_created on public.ai_usage(workspace_id, created_at desc);

alter table public.ai_usage enable row level security;
create policy ai_usage_owned on public.ai_usage for select to authenticated using (public.owns_workspace(workspace_id));
revoke all on public.ai_usage from public, anon, authenticated;
grant select on public.ai_usage to authenticated;
grant all on public.ai_usage to service_role;

insert into public.ai_usage(workspace_id, created_at, task, model_id, source, input_tokens, output_tokens, status, conversation_id)
select workspace_id, created_at, 'chat', usage->>'model_id', 'unknown',
  case when jsonb_typeof(usage->'input_tokens') = 'number' then (usage->>'input_tokens')::bigint end,
  case when jsonb_typeof(usage->'output_tokens') = 'number' then (usage->>'output_tokens')::bigint end,
  case status when 'failed' then 'failed' when 'canceled' then 'canceled' else 'succeeded' end,
  conversation_id
from public.chat_requests
where jsonb_typeof(usage) = 'object' and jsonb_typeof(usage->'model_id') = 'string' and char_length(usage->>'model_id') between 1 and 200;
