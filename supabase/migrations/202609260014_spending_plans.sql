-- Monthly per-category spending plans (budgets as targets, not predictions).
--
-- Scope: minimal. One row = one category's monthly limit in exact minor
-- units, scoped to workspace + currency. Current-month progress is derived
-- in app code from posted ordinary transactions net of refunds (see
-- lib/finance/spending-plans.ts); plans never touch account balances and
-- are distinct from goal_allocations reservations.
--
-- Invariants (cross-row checks live in app/RLS, not CHECKs):
-- * limit_minor > 0, exact minor units, no floats.
-- * category must belong to the same workspace (enforced in RLS WITH CHECK).
-- * spending counts only posted, non-transfer rows in the plan currency.

create table public.spending_plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  category_id uuid not null references public.categories(id) on delete cascade,
  currency_code text not null constraint spending_plans_currency_code check (currency_code ~ '^[A-Z]{3}$'),
  limit_minor bigint not null constraint spending_plans_limit_positive check (limit_minor > 0),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spending_plans_workspace_category_currency_unique unique (workspace_id, category_id, currency_code)
);

create index if not exists spending_plans_workspace_idx
  on public.spending_plans (workspace_id);

alter table public.spending_plans enable row level security;

create policy own_spending_plans on public.spending_plans for all to authenticated
using (public.owns_workspace(workspace_id)
  and exists (select 1 from public.categories
    where id = category_id and workspace_id = spending_plans.workspace_id))
with check (public.owns_workspace(workspace_id)
  and exists (select 1 from public.categories
    where id = category_id and workspace_id = spending_plans.workspace_id));

-- Explicit grants (see 202609260013_authenticated_grants.sql): the user
-- creates, edits limits, and enables/disables plans directly.
grant select, insert, update, delete on public.spending_plans to authenticated;
