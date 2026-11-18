import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/auth";
import { enableBankingConfigured } from "@/lib/bank/enable-banking";
import { psuFrom } from "@/lib/bank/server";
import { serviceDb } from "@/lib/service-db";
import { startBankSync } from "@/lib/bank/start-sync";
import { scalableConfigured } from "@/lib/scalable/server";
import { syncScalable } from "@/lib/scalable/sync";
import { hasServiceRoleKey, isDesktopPreview } from "@/lib/env";

const SCALABLE_EVERY_MS = 15 * 60_000, BANK_EVERY_MS = 60 * 60_000;
const stamp = (value: string | null | undefined) => value ? Date.parse(value) : 0;
const tried = new Map<string, number>();
function scalableDue(connection: { id: string; last_synced_at: string | null }) {
  const now = Date.now();
  if (now - Math.max(stamp(connection.last_synced_at), tried.get(connection.id) ?? 0) < SCALABLE_EVERY_MS) return false;
  tried.set(connection.id, now);
  return true;
}
const bankDue = (connection: { last_synced_at: string | null; last_attempted_at: string | null }) =>
  Date.now() - Math.max(stamp(connection.last_synced_at), stamp(connection.last_attempted_at)) >= BANK_EVERY_MS;

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  if (isDesktopPreview())
    return NextResponse.json({ refresh: false });
  const { supabase, workspace } = context;
  const [scalable, banks] = await Promise.all([
    supabase.from("scalable_connections").select("id, last_synced_at").eq("workspace_id", workspace.id).eq("status", "active"),
    supabase.from("bank_connections").select("id, last_synced_at, last_attempted_at").eq("workspace_id", workspace.id).eq("status", "active"),
  ]);
  if (scalable.error || banks.error) return NextResponse.json({ error: "Connections are unavailable" }, { status: 503 });
  const syncs: Promise<boolean>[] = [];
  if (scalableConfigured()) for (const row of scalable.data ?? []) if (scalableDue(row)) syncs.push(syncScalable(row.id, workspace.id).then(() => true, () => true));
  if ((banks.data ?? []).length && hasServiceRoleKey() && await enableBankingConfigured()) for (const row of banks.data ?? [])
    if (bankDue(row)) syncs.push(startBankSync(row.id, workspace.id, psuFrom(request)).then(async run => { if (!run) return false; await run.returnValue; return true; })
      .catch(async () => { await serviceDb().from("bank_connections").update({ last_error: "The bank sync could not start. Moneo tries again by itself." }).eq("id", row.id); return true; }));
  const ran = await Promise.all(syncs);
  return NextResponse.json({ refresh: ran.some(Boolean) });
}
