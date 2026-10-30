-- One record per finished voice call in a conversation: how long it lasted, the live-caption transcript, the
-- requests it started (their chat messages are grouped under the call in the chat) and a short summary that is
-- written after hang-up.
create table public.voice_calls (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  duration_seconds integer not null check (duration_seconds between 0 and 86400),
  transcript jsonb not null check (jsonb_typeof(transcript) = 'array' and octet_length(transcript::text) <= 60000),
  tasks jsonb not null check (jsonb_typeof(tasks) = 'array' and octet_length(tasks::text) <= 60000),
  summary text check (length(summary) <= 2000),
  summary_status text not null default 'pending' check (summary_status in ('pending','done','failed')),
  created_at timestamptz not null default now()
);
create index voice_calls_conversation_created on public.voice_calls(conversation_id, created_at);

alter table public.voice_calls enable row level security;
create policy own_voice_calls on public.voice_calls for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id) and exists (
  select 1 from public.conversations where id = conversation_id and workspace_id = voice_calls.workspace_id
));
revoke all on public.voice_calls from public, anon;
grant select, insert on public.voice_calls to authenticated;
grant update (summary, summary_status) on public.voice_calls to authenticated;
