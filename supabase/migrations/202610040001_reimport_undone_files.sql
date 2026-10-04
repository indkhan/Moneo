-- Undo retains the original import and source evidence; importing those bytes again
-- creates a fresh run. Active runs still deduplicate concurrent confirmations.
alter table public.imports drop constraint imports_workspace_hash_unique;
create unique index imports_workspace_hash_unique on public.imports(workspace_id, file_hash)
  where status <> 'undone';
