// A sync runs from sync_started_at until finishBankSync stamps last_synced_at. One that never
// finished (a crashed run) stops counting as running after 15 minutes so it can be retried.
export const SYNC_STALE_MS = 15 * 60_000;

export function syncRunning(connection: { sync_started_at: string | null; last_synced_at: string | null }, now = Date.now()) {
  if (!connection.sync_started_at) return false;
  const started = Date.parse(connection.sync_started_at);
  return now - started < SYNC_STALE_MS && (!connection.last_synced_at || Date.parse(connection.last_synced_at) < started);
}

// PSD2 allows about 4 background fetches a day per account, so without the owner present an account
// waits 20 hours after its last try. A bank's Retry-After (next_allowed_at) holds every trigger back.
export const BACKGROUND_SPACING_MS = 20 * 3_600_000;

export function accountDue(account: { last_attempted_at: string | null; next_allowed_at: string | null }, ownerPresent: boolean, now = Date.now()) {
  if (account.next_allowed_at && Date.parse(account.next_allowed_at) > now) return false;
  return ownerPresent || !account.last_attempted_at || now - Date.parse(account.last_attempted_at) >= BACKGROUND_SPACING_MS;
}
