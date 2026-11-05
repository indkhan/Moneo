-- Scalable Capital connections over the official Scalable MCP (OAuth 2.1 + PKCE, public client).
-- client_id comes from dynamic client registration and is public. The PKCE verifier (while pending)
-- and the OAuth tokens (once active) are AES-256-GCM sealed and readable by service_role only.
create table public.scalable_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id text not null check (char_length(client_id) between 1 and 200),
  redirect_uri text not null check (char_length(redirect_uri) between 1 and 500),
  auth_state uuid not null unique default gen_random_uuid(),
  pkce_verifier_encrypted text,
  tokens_encrypted text,
  status text not null default 'pending' check (status in ('pending','active','expired','revoked','error')),
  last_synced_at timestamptz,
  last_error text check (char_length(last_error) <= 1000),
  created_at timestamptz not null default now(),
  check (status <> 'active' or tokens_encrypted is not null)
);
create index scalable_connections_workspace_idx on public.scalable_connections(workspace_id);

alter table public.scalable_connections enable row level security;
create policy scalable_connections_owned on public.scalable_connections for select using(public.owns_workspace(workspace_id));
revoke all on public.scalable_connections from anon,authenticated;
-- Owners read status only, never the sealed verifier, the tokens or the redirect state.
grant select (id, workspace_id, status, last_synced_at, last_error, created_at) on public.scalable_connections to authenticated;
grant all on public.scalable_connections to service_role;
