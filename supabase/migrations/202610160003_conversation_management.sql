-- Owners can rename and delete chats. Deletion is a soft delete so chat requests,
-- audited AI edits and retained evidence keep their history.
alter table public.conversations add column deleted_at timestamptz;
create index conversations_workspace_live on public.conversations(workspace_id, created_at desc, id desc) where deleted_at is null;
grant update (title, deleted_at) on public.conversations to authenticated;
