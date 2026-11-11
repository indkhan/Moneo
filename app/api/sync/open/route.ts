import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { requireWorkspace } from "@/lib/auth";
import { enableBankingConfigured } from "@/lib/bank/enable-banking";
import { psuFrom, serviceDb } from "@/lib/bank/server";
import { syncRunning } from "@/lib/bank/sync-state";
import { scalableConfigured } from "@/lib/scalable/server";
import { syncScalable } from "@/lib/scalable/sync";
import { syncBankConnection } from "@/workflows/bank-sync";

const SCALABLE_EVERY_MS = 15 * 60_000, BANK_EVERY_MS = 60 * 60_000;
// Tries that have not stamped last_synced_at yet: other tabs, or a sync that failed.
const tried = new Map<string, number>();
function due(connection: { id: string; last_synced_at: string | null; last_attempted_at?: string | null }, everyMs: number) {
  const now = Date.now();
  const last = Math.max(connection.last_synced_at ? Date.parse(connection.last_synced_at) : 0, connection.last_attempted_at ? Date.parse(connection.last_attempted_at) : 0, tried.get(connection.id) ?? 0);
  if (now - last < everyMs) return false;
  tried.set(connection.id, now);
  return true;
}

// Opening or returning to Moneo: the page already shows the last numbers, and this answers once fresher ones have landed.
// The owner is present, so bank fetches carry PSU headers and don't use the background allowance. Failures are kept on the connection.
export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  if (process.env.MONEO_DESKTOP === "1" && process.env.MONEO_DESKTOP_PREVIEW === "1")
    return NextResponse.json({ refresh: false });
  const { supabase, workspace } = context;
  const [scalable, banks] = await Promise.all([
    supabase.from("scalable_connections").select("id, last_synced_at").eq("workspace_id", workspace.id).eq("status", "active"),
    supabase.from("bank_connections").select("id, last_synced_at, last_attempted_at, sync_started_at").eq("workspace_id", workspace.id).eq("status", "active"),
  ]);
  if (scalable.error || banks.error) return NextResponse.json({ error: "Connections are unavailable" }, { status: 503 });
  const syncs: Promise<unknown>[] = [];
  if (scalableConfigured()) for (const row of scalable.data ?? []) if (due(row, SCALABLE_EVERY_MS)) syncs.push(syncScalable(row.id, workspace.id));
  if ((banks.data ?? []).length && process.env.SUPABASE_SERVICE_ROLE_KEY && await enableBankingConfigured()) for (const row of banks.data ?? [])
    if (!syncRunning(row) && due(row, BANK_EVERY_MS)) syncs.push(start(syncBankConnection, [row.id, workspace.id, psuFrom(request)]).then(run => run.returnValue)
      // A run that never got going has no workflow to record why, so the connection hears it here.
      .catch(() => serviceDb().from("bank_connections").update({ last_error: "The bank sync could not start. Moneo tries again by itself." }).eq("id", row.id)));
  await Promise.allSettled(syncs);
  return NextResponse.json({ refresh: syncs.length > 0 });
}
