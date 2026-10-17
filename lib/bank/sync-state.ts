// A sync runs from sync_started_at until finishBankSync stamps last_synced_at. One that never
// finished (a crashed run) stops counting as running after 15 minutes so it can be retried.
export const SYNC_STALE_MS = 15 * 60_000;

export function syncRunning(connection: { sync_started_at: string | null; last_synced_at: string | null }, now = Date.now()) {
  if (!connection.sync_started_at) return false;
  const started = Date.parse(connection.sync_started_at);
  return now - started < SYNC_STALE_MS && (!connection.last_synced_at || Date.parse(connection.last_synced_at) < started);
}
