import { start } from "workflow/api";
import type { PsuContext } from "@/lib/bank/enable-banking";
import { serviceDb } from "@/lib/bank/server";
import { claimBankSync, releasedLease } from "@/lib/bank/sync-lease";
import { syncBankConnection } from "@/workflows/bank-sync";

/** Every bank sync starts here. Null means another sync already holds the connection. */
export async function startBankSync(connectionId: string, workspaceId: string, psu?: PsuContext) {
  const db = serviceDb();
  const token = await claimBankSync(db, connectionId, workspaceId);
  if (!token) return null;
  try {
    return await start(syncBankConnection, psu ? [connectionId, workspaceId, token, psu] : [connectionId, workspaceId, token]);
  } catch (error) {
    // Nothing runs under this lease, so free it rather than wait for it to run out.
    await db.from("bank_connections").update({ ...releasedLease, sync_started_at: null }).eq("id", connectionId).eq("sync_lease_token", token);
    throw error;
  }
}
