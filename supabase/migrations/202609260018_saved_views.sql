-- Minimal saved transaction views (prompt.md §7).
--
-- One row = a named workspace-scoped filter preset for Money → Transactions.
-- Only the allowlisted filter keys documented in app/money/views/validate.ts
-- are stored in `filters` (q/from/to/account/status/kind/direction/
-- category/merchant/amount range/sort). Cursor and open-transaction ids are
-- never stored.
--
-- Tenant privacy: opening a view uses the opaque row UUID (?view=<uuid>)
-- loaded and applied on the server. Sensitive search terms and account /
-- category / merchant UUIDs live only in the workspace-scoped JSONB column
-- and are never serialized into the saved-view link. All access is gated by
-- RLS through public.owns_workspace; cross-workspace ids stored in `filters`
-- simply match nothing because every transaction query is workspace-scoped.
--
-- Invariants (shape checks live in app code, not CHECKs):
-- * name 1–80 chars (enforced here).
-- * filters must be a JSON object (enforced here); key/value allowlist
--   enforced in app/money/views/validate.ts on save and tolerated on load
--   (unknown keys ignored so future keys stay backward compatible).

create table public.transaction_views (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null constraint transaction_views_name_length check (char_length(name) between 1 and 80),
  filters jsonb not null default '{}'::jsonb constraint transaction_views_filters_object check (jsonb_typeof(filters) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists transaction_views_workspace_idx
  on public.transaction_views (workspace_id, created_at desc);

alter table public.transaction_views enable row level security;

create policy own_transaction_views on public.transaction_views for all to authenticated
using (public.owns_workspace(workspace_id))
with check (public.owns_workspace(workspace_id));

-- Minimal grants: the user lists, saves (insert) and deletes views directly.
-- No update path exists in the UI; rename is delete + save.
grant select, insert, delete on public.transaction_views to authenticated;
