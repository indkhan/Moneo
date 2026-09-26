create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  title text not null,
  created_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  conversation_id uuid not null references public.conversations(id),
  role text not null check (role in ('user', 'assistant')),
  request_id uuid,
  reply_to uuid,
  content text not null,
  context jsonb,
  created_at timestamptz not null default now()
);

create unique index messages_request_unique on public.messages(conversation_id, request_id) where request_id is not null;
create unique index messages_reply_unique on public.messages(conversation_id, reply_to) where reply_to is not null;

create index messages_conversation_created on public.messages(conversation_id, created_at);

alter table public.conversations enable row level security;
alter table public.messages enable row level security;

create policy own_conversations on public.conversations for all to authenticated
using (public.owns_workspace(workspace_id)) with check (public.owns_workspace(workspace_id));

create policy own_messages on public.messages for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id) and exists (
  select 1 from public.conversations where id = conversation_id and workspace_id = messages.workspace_id
));
