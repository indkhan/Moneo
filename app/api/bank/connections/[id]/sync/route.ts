import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { enableBankingConfigured } from "@/lib/bank/enable-banking";
import { psuFrom } from "@/lib/bank/server";
import { syncRunning } from "@/lib/bank/sync-state";
import { syncBankConnection } from "@/workflows/bank-sync";

// "Sync now" is user-present (PSU headers), so it doesn't use the background fetch allowance.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!enableBankingConfigured() || !process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: "Bank sync is not configured" }, { status: 503 });
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const connection = await context.supabase.from("bank_connections").select("status, last_synced_at, sync_started_at").eq("id", id.data).eq("workspace_id", context.workspace.id).maybeSingle();
  if (connection.error || !connection.data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (connection.data.status !== "active") return NextResponse.json({ error: "Reconnect this bank before syncing" }, { status: 409 });
  if (syncRunning(connection.data)) return NextResponse.json({ error: "A sync is already running" }, { status: 409 });
  if (connection.data.last_synced_at && Date.now() - Date.parse(connection.data.last_synced_at) < 60_000)
    return NextResponse.json({ error: "Synced less than a minute ago" }, { status: 429 });
  await start(syncBankConnection, [id.data, context.workspace.id, psuFrom(request)]);
  return NextResponse.json({ status: "started" });
}
