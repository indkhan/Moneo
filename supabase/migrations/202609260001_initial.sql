create extension if not exists pgcrypto;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  name text not null default 'My finances',
  display_currency text not null default 'EUR',
  created_at timestamptz not null default now()
);

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  name text not null,
  type text not null default 'checking',
  currency_code text not null,
  created_at timestamptz not null default now()
);

create table public.balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  account_id uuid not null references public.accounts(id),
  amount_minor bigint not null,
  currency_code text not null,
  as_of timestamptz not null,
  provenance text not null,
  created_at timestamptz not null default now()
);

create table public.data_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  account_id uuid references public.accounts(id),
  kind text not null,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.imports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  source_id uuid references public.data_sources(id),
  filename text not null,
  storage_path text not null,
  file_hash text not null,
  status text not null default 'pending',
  mapping jsonb,
  total_rows integer not null default 0,
  new_rows integer not null default 0,
  matched_rows integer not null default 0,
  review_rows integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  constraint imports_workspace_hash_unique unique (workspace_id, file_hash)
);

create table public.source_transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  import_id uuid not null references public.imports(id),
  row_number integer not null,
  original_row jsonb not null,
  external_id text,
  status text not null default 'new',
  constraint source_transactions_import_row_unique unique (import_id, row_number)
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  name text not null,
  constraint categories_workspace_name_unique unique (workspace_id, name)
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  account_id uuid not null references public.accounts(id),
  posted_on date not null,
  description text not null,
  amount_minor bigint not null,
  currency_code text not null,
  status text not null default 'posted',
  kind text not null default 'ordinary',
  category_id uuid references public.categories(id),
  note text,
  transfer_id uuid,
  refund_of_id uuid,
  created_at timestamptz not null default now()
);

create table public.transaction_sources (
  transaction_id uuid not null references public.transactions(id),
  source_transaction_id uuid not null unique references public.source_transactions(id)
);

create table public.correction_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  transaction_id uuid not null references public.transactions(id),
  actor_id uuid not null,
  before jsonb not null,
  after jsonb not null,
  undone boolean not null default false,
  created_at timestamptz not null default now()
);

create function public.create_private_workspace()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.workspaces (owner_id) values (new.id);
  return new;
end;
$$;

create trigger create_private_workspace_after_signup
after insert on auth.users for each row execute function public.create_private_workspace();

insert into public.workspaces (owner_id)
select id from auth.users
on conflict (owner_id) do nothing;

create function public.owns_workspace(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspaces where id = target and owner_id = (select auth.uid()));
$$;

revoke all on function public.owns_workspace(uuid) from public;
grant execute on function public.owns_workspace(uuid) to authenticated;

alter table public.workspaces enable row level security;
alter table public.accounts enable row level security;
alter table public.balance_snapshots enable row level security;
alter table public.data_sources enable row level security;
alter table public.imports enable row level security;
alter table public.source_transactions enable row level security;
alter table public.categories enable row level security;
alter table public.transactions enable row level security;
alter table public.transaction_sources enable row level security;
alter table public.correction_events enable row level security;

create policy own_workspace on public.workspaces for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy own_accounts on public.accounts for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id));

create policy own_balance_snapshots on public.balance_snapshots for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id) and exists (
  select 1 from public.accounts where id = account_id and workspace_id = balance_snapshots.workspace_id
));

create policy own_data_sources on public.data_sources for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id) and (account_id is null or exists (
  select 1 from public.accounts where id = account_id and workspace_id = data_sources.workspace_id
)));

create policy own_imports on public.imports for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id) and (source_id is null or exists (
  select 1 from public.data_sources where id = source_id and workspace_id = imports.workspace_id
)));

create policy own_source_transactions on public.source_transactions for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id) and exists (
  select 1 from public.imports where id = import_id and workspace_id = source_transactions.workspace_id
));

create policy own_categories on public.categories for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id));

create policy own_transactions on public.transactions for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id)
  and exists (select 1 from public.accounts where id = account_id and workspace_id = transactions.workspace_id)
  and (category_id is null or exists (select 1 from public.categories where id = category_id and workspace_id = transactions.workspace_id))
  and (refund_of_id is null or exists (select 1 from public.transactions where id = refund_of_id and workspace_id = transactions.workspace_id))
);

create policy own_transaction_sources on public.transaction_sources for all to authenticated
using (exists (
  select 1 from public.transactions t join public.source_transactions s on s.id = source_transaction_id
  where t.id = transaction_id and t.workspace_id = s.workspace_id and public.owns_workspace(t.workspace_id)
))
with check (exists (
  select 1 from public.transactions t join public.source_transactions s on s.id = source_transaction_id
  where t.id = transaction_id and t.workspace_id = s.workspace_id and public.owns_workspace(t.workspace_id)
));

create policy own_correction_events on public.correction_events for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id) and actor_id = (select auth.uid()) and exists (
  select 1 from public.transactions where id = transaction_id and workspace_id = correction_events.workspace_id
));

insert into storage.buckets (id, name, public)
values ('imports', 'imports', false), ('artifacts', 'artifacts', false)
on conflict (id) do update set public = false;

create policy private_finance_files on storage.objects for all to authenticated
using (
  bucket_id in ('imports', 'artifacts') and exists (
    select 1 from public.workspaces
    where owner_id = (select auth.uid()) and id::text = (storage.foldername(objects.name))[1]
  )
)
with check (
  bucket_id in ('imports', 'artifacts') and exists (
    select 1 from public.workspaces
    where owner_id = (select auth.uid()) and id::text = (storage.foldername(objects.name))[1]
  )
);
