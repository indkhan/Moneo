import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/auth";
import { enableBankingConfigured } from "@/lib/bank/enable-banking";
import { psuFrom, serviceDb } from "@/lib/bank/server";
import { startBankSync } from "@/lib/bank/start-sync";
import { scalableConfigured } from "@/lib/scalable/server";
import { syncScalable } from "@/lib/scalable/sync";

const SCALABLE_EVERY_MS = 15 * 60_000, BANK_EVERY_MS = 60 * 60_000;
const stamp = (value: string | null | undefined) => value ? Date.parse(value) : 0;
// Scalable tries that have not stamped last_synced_at yet: other tabs, or a sync that failed.
const tried = new Map<string, number>();
function scalableDue(connection: { id: string; last_synced_at: string | null }) {
  const now = Date.now();
  if (now - Math.max(stamp(connection.last_synced_at), tried.get(connection.id) ?? 0) < SCALABLE_EVERY_MS) return false;
  tried.set(connection.id, now);
  return true;
}
// A bank's own lease keeps tabs and other triggers from starting a second sync; last_attempted_at spaces failed ones.
const bankDue = (connection: { last_synced_at: string | null; last_attempted_at: string | null }) =>
  Date.now() - Math.max(stamp(connection.last_synced_at), stamp(connection.last_attempted_at)) >= BANK_EVERY_MS;

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
    supabase.from("bank_connections").select("id, last_synced_at, last_attempted_at").eq("workspace_id", workspace.id).eq("status", "active"),
  ]);
  if (scalable.error || banks.error) return NextResponse.json({ error: "Connections are unavailable" }, { status: 503 });
  const syncs: Promise<boolean>[] = [];
  if (scalableConfigured()) for (const row of scalable.data ?? []) if (scalableDue(row)) syncs.push(syncScalable(row.id, workspace.id).then(() => true, () => true));
  if ((banks.data ?? []).length && process.env.SUPABASE_SERVICE_ROLE_KEY && await enableBankingConfigured()) for (const row of banks.data ?? [])
    if (bankDue(row)) syncs.push(startBankSync(row.id, workspace.id, psuFrom(request)).then(async run => { if (!run) return false; await run.returnValue; return true; })
      // A run that never got going has no workflow to record why, so the connection hears it here.
      .catch(async () => { await serviceDb().from("bank_connections").update({ last_error: "The bank sync could not start. Moneo tries again by itself." }).eq("id", row.id); return true; }));
  const ran = await Promise.all(syncs);
  return NextResponse.json({ refresh: ran.some(Boolean) });
}
