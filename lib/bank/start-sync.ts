import { start } from "workflow/api";
import type { PsuContext } from "@/lib/bank/enable-banking";
import { serviceDb } from "@/lib/service-db";
import { claimBankSync, releasedLease } from "@/lib/bank/sync-lease";
import { syncBankConnection } from "@/workflows/bank-sync";

export async function startBankSync(connectionId: string, workspaceId: string, psu?: PsuContext, aligned = false) {
  const db = serviceDb();
  const token = await claimBankSync(db, connectionId, workspaceId);
  if (!token) return null;
  try {
    return await start(syncBankConnection, psu ? [connectionId, workspaceId, token, psu] : aligned ? [connectionId, workspaceId, token, undefined, true] : [connectionId, workspaceId, token]);
  } catch (error) {
    await db.from("bank_connections").update({ ...releasedLease, sync_started_at: null }).eq("id", connectionId).eq("sync_lease_token", token);
    throw error;
  }
}
