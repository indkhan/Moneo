export const SYNC_STALE_MS = 15 * 60_000;

export function syncRunning(connection: { sync_started_at: string | null; last_synced_at: string | null }, now = Date.now()) {
  if (!connection.sync_started_at) return false;
  const started = Date.parse(connection.sync_started_at);
  return now - started < SYNC_STALE_MS && (!connection.last_synced_at || Date.parse(connection.last_synced_at) < started);
}

export const BACKGROUND_SPACING_MS = 20 * 3_600_000;
export const ALIGNED_SPACING_MS = 12 * 3_600_000;

export function accountDue(account: { last_attempted_at: string | null; next_allowed_at: string | null }, ownerPresent: boolean, now = Date.now(), spacing = BACKGROUND_SPACING_MS) {
  if (account.next_allowed_at && Date.parse(account.next_allowed_at) > now) return false;
  return ownerPresent || !account.last_attempted_at || now - Date.parse(account.last_attempted_at) >= spacing;
}

export function nextBackgroundSync(accounts: { last_attempted_at: string | null; next_allowed_at: string | null }[], now = Date.now()) {
  const times = accounts.map(account => Math.max(now, account.last_attempted_at ? Date.parse(account.last_attempted_at) + BACKGROUND_SPACING_MS : now,
    account.next_allowed_at ? Date.parse(account.next_allowed_at) : now));
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}
