-- One sync per bank connection at a time. Every trigger (open, Sync now, the hourly job, a new consent) takes the
-- lease first; it runs out after 15 minutes so a crashed run can't block syncing. Only the holder may finish a sync.
alter table public.bank_connections add column sync_lease_token uuid, add column sync_lease_until timestamptz;

-- Each bank account keeps its own timing: one account's rate limit or error no longer holds back the others.
-- last_attempted_at spaces background fetches (about 4 a day are allowed); next_allowed_at honours the bank's Retry-After.
alter table public.bank_connection_accounts
  add column last_attempted_at timestamptz,
  add column next_allowed_at timestamptz,
  add column last_error text check (char_length(last_error) <= 1000);
update public.bank_connection_accounts account set last_attempted_at = connection.last_attempted_at
  from public.bank_connections connection where connection.id = account.connection_id;

-- Takes a free or run-out lease on an active connection and marks the sync running for the UI.
create function public.claim_bank_sync(p_connection_id uuid, p_workspace_id uuid, p_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  update public.bank_connections set sync_lease_token = p_token, sync_lease_until = now() + interval '15 minutes', sync_started_at = now()
    where id = p_connection_id and workspace_id = p_workspace_id and status = 'active'
      and (sync_lease_until is null or sync_lease_until < now());
  return found;
end;
$$;

-- Extends the caller's lease while it still holds it. A run whose lease ran out gets false and must stop.
create function public.hold_bank_sync(p_connection_id uuid, p_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  update public.bank_connections set sync_lease_until = now() + interval '15 minutes'
    where id = p_connection_id and sync_lease_token = p_token and sync_lease_until >= now();
  return found;
end;
$$;

revoke all on function public.claim_bank_sync(uuid, uuid, uuid), public.hold_bank_sync(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_bank_sync(uuid, uuid, uuid), public.hold_bank_sync(uuid, uuid) to service_role;
