-- Simplest import-time merchant and category capture.
--
-- Merchants are workspace-scoped canonical names linked via
-- transactions.merchant_id. Categories are only created when the source file
-- has an explicit category column; uncertain rows stay uncategorized (null)
-- and never block the import.
--
-- Raw source evidence is preserved in source_transactions.original_row and
-- transactions.description keeps the original description text.
--
-- Idempotent/retry safe: merchants are keyed by (workspace_id,
-- normalized_name) with deterministic stable ids from the workflow, so
-- retries upsert the same row. Transactions keep onConflict-ignore inserts,
-- so a retry never overwrites a later user correction. Undo Import keeps
-- working unchanged: merchants/categories are shared reference data and are
-- never deleted by preview_import_undo/undo_import (like accounts).
-- Tenant safe: RLS + owns_workspace checks; transactions.merchant_id must
-- reference a merchant in the same workspace.

create table public.merchants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  name text not null check (char_length(name) between 1 and 100),
  normalized_name text not null check (char_length(normalized_name) between 1 and 100),
  created_at timestamptz not null default now(),
  constraint merchants_workspace_normalized_unique unique (workspace_id, normalized_name)
);

create index merchants_workspace_normalized_idx
  on public.merchants (workspace_id, normalized_name);

alter table public.transactions
  add column merchant_id uuid;

alter table public.transactions
  add constraint transactions_merchant_id_fkey
  foreign key (merchant_id) references public.merchants(id) on delete set null;

create index if not exists transactions_merchant_id_idx
  on public.transactions (merchant_id) where merchant_id is not null;

alter table public.merchants enable row level security;

create policy own_merchants on public.merchants for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id));

-- Keep the existing workspace linkage guarantees and extend them to merchant_id.
drop policy if exists own_transactions on public.transactions;
create policy own_transactions on public.transactions for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id)
  and exists (select 1 from public.accounts where id = account_id and workspace_id = transactions.workspace_id)
  and (category_id is null or exists (select 1 from public.categories where id = category_id and workspace_id = transactions.workspace_id))
  and (merchant_id is null or exists (select 1 from public.merchants where id = merchant_id and workspace_id = transactions.workspace_id))
  and (refund_of_id is null or exists (select 1 from public.transactions where id = refund_of_id and workspace_id = transactions.workspace_id))
  and (transfer_id is null or exists (select 1 from public.transactions where id = transfer_id and workspace_id = transactions.workspace_id))
);
