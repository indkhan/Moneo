import type { SupabaseClient } from "@supabase/supabase-js";

// historyMissing: a bank account failed before its first transactions ever arrived.
type Connection = { name: string; status: string; last_error: string | null; historyMissing?: boolean };

/** Sentences for connections that need the owner. An old ended login doesn't count once the same service is connected again. */
export function syncProblems(connections: Connection[]) {
  const active = new Set(connections.filter(row => row.status === "active").map(row => row.name));
  return [...new Set(connections.flatMap(({ name, status, last_error, historyMissing }) => {
    if (status !== "active") return active.has(name) ? [] : [`${name} needs reconnecting, so its numbers may be old.`];
    if (last_error && historyMissing) return [`${name} hasn't sent its transaction history yet, so its numbers are incomplete. Moneo tries again by itself.`];
    return last_error ? [`${name} could not sync, so its numbers may be old. Moneo tries again by itself.`] : [];
  }))];
}

/** What Home must say about syncing. A failed check says nothing: the numbers still show. */
export async function loadSyncProblems(db: SupabaseClient, workspaceId: string) {
  const live = ["active", "expired", "error"];
  const [banks, scalable] = await Promise.all([
    db.from("bank_connections").select("aspsp_name, status, last_error, accounts:bank_connection_accounts(last_booked_on, last_error)").eq("workspace_id", workspaceId).in("status", live),
    db.from("scalable_connections").select("status, last_error").eq("workspace_id", workspaceId).in("status", live),
  ]);
  return syncProblems([...(banks.data ?? []).map(({ aspsp_name, accounts, ...row }) =>
    ({ ...row, name: aspsp_name, historyMissing: accounts.some(account => account.last_error && !account.last_booked_on) })), ...(scalable.data ?? []).map(row => ({ ...row, name: "Scalable" }))]);
}
