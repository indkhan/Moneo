-- When the owner chose Skip all on the Home uncategorized review.
alter table public.workspace_settings add column uncategorized_skipped_at timestamptz;
