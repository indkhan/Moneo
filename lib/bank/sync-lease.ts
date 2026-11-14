import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// One sync per bank connection at a time (202611130003). The lease runs out after 15 minutes, so a crashed run
// doesn't block syncing; a run must still hold it to move the account cursors or publish its result.

/** The new lease's token, or null when another sync holds the connection or it isn't active. */
export async function claimBankSync(db: SupabaseClient, connectionId: string, workspaceId: string) {
  const token = randomUUID();
  const claimed = await db.rpc("claim_bank_sync", { p_connection_id: connectionId, p_workspace_id: workspaceId, p_token: token });
  if (claimed.error) throw new Error(claimed.error.message);
  return claimed.data === true ? token : null;
}

/** Extends the lease while this run still holds it; false once it ran out. */
export async function holdBankSync(db: SupabaseClient, connectionId: string, token: string) {
  const held = await db.rpc("hold_bank_sync", { p_connection_id: connectionId, p_token: token });
  if (held.error) throw new Error(held.error.message);
  return held.data === true;
}

export const releasedLease = { sync_lease_token: null, sync_lease_until: null };
