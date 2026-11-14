import { enableBankingConfigured } from "@/lib/bank/enable-banking";
import { serviceDb } from "@/lib/bank/server";
import { startBankSync } from "@/lib/bank/start-sync";
import { ALIGNED_SPACING_MS, accountDue } from "@/lib/bank/sync-state";

export const maxDuration = 60;

// Background sync without PSU headers: a connection runs when any of its accounts is due, and the run
// fetches only those. Each account waits 20 hours between tries, under the ~4/day PSD2 allowance; once one
// is due, the workspace's other banks join (ALIGNED_SPACING_MS), so they all land before one agent pass.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !(await enableBankingConfigured())) return Response.json({ error: "Bank sync unavailable" }, { status: 503 });
  // ponytail: 1000 accounts per run is plenty for personal use; page before going multi-user.
  const { data, error } = await serviceDb().from("bank_connection_accounts").select("connection_id, workspace_id, last_attempted_at, next_allowed_at, bank_connections!inner(status)")
    .eq("bank_connections.status", "active").order("connection_id").limit(1000);
  if (error) return Response.json({ error: "Bank connections unavailable" }, { status: 503 });
  const now = Date.now(), rows = data ?? [];
  const workspaces = new Set(rows.filter(row => accountDue(row, false, now)).map(row => row.workspace_id));
  const due = new Map<string, string>();
  for (const row of rows) if (workspaces.has(row.workspace_id) && accountDue(row, false, now, ALIGNED_SPACING_MS)) due.set(row.connection_id, row.workspace_id);
  let started = 0, busy = 0, failed = 0;
  for (const [connectionId, workspaceId] of due) {
    try { if (await startBankSync(connectionId, workspaceId, undefined, true)) started++; else busy++; }
    catch { failed++; }
  }
  return Response.json({ started, busy, failed });
}
