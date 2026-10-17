-- When the running (or last) sync started, so the app can show live progress after the user
-- leaves and returns. A sync is running while sync_started_at is newer than last_synced_at.
alter table public.bank_connections add column sync_started_at timestamptz;
grant select (sync_started_at) on public.bank_connections to authenticated;
