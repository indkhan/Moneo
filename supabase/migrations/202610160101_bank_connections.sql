-- Enable Banking connections (issue #82). Each sync is written as an ordinary import,
-- so these tables only hold the consent handle and which provider accounts it covers.
-- session_id_encrypted is an AES-256-GCM bearer handle: service_role only, never granted to authenticated.
create table public.bank_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  provider text not null default 'enable_banking' check (provider = 'enable_banking'),
  aspsp_name text not null check (char_length(aspsp_name) between 1 and 200),
  aspsp_country text not null check (aspsp_country ~ '^[A-Z]{2}$'),
  session_id_encrypted text,
  auth_state uuid not null unique default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending','active','expired','revoked','error')),
  valid_until timestamptz,
  last_synced_at timestamptz,
  last_error text check (char_length(last_error) <= 1000),
  created_at timestamptz not null default now(),
  check (status <> 'active' or (session_id_encrypted is not null and valid_until is not null))
);
create index bank_connections_workspace_idx on public.bank_connections(workspace_id);

create table public.bank_connection_accounts (
  connection_id uuid not null references public.bank_connections(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id),
  provider_account_uid text not null check (char_length(provider_account_uid) between 1 and 200),
  iban text check (char_length(iban) <= 34),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  account_name text not null check (char_length(account_name) between 1 and 100),
  last_booked_on date,
  primary key (connection_id, provider_account_uid)
);

alter table public.bank_connections enable row level security;
alter table public.bank_connection_accounts enable row level security;
create policy bank_connections_owned on public.bank_connections for select using(public.owns_workspace(workspace_id));
create policy bank_connection_accounts_owned on public.bank_connection_accounts for select using(public.owns_workspace(workspace_id));
revoke all on public.bank_connections, public.bank_connection_accounts from anon,authenticated;
-- Column grant: owners read status and expiry, never the encrypted session or the redirect state.
grant select (id, workspace_id, provider, aspsp_name, aspsp_country, status, valid_until, last_synced_at, last_error, created_at)
  on public.bank_connections to authenticated;
grant select on public.bank_connection_accounts to authenticated;
grant all on public.bank_connections, public.bank_connection_accounts to service_role;
