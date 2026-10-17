import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/auth";
import { enableBankingConfigured } from "@/lib/bank/enable-banking";
import { syncRunning } from "@/lib/bank/sync-state";

type SyncImport = { id: string; status: string; total_rows: number; new_rows: number; matched_rows: number; review_rows: number; rejected_rows: number; created_at: string; mapping: { accountName?: string } | null };

// Connected banks for the UI. RLS plus the column grant keep the encrypted session out of reach.
// Each connection carries its latest sync's imports, so progress survives leaving the page.
export async function GET() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const { data, error } = await context.supabase.from("bank_connections")
    .select("id, aspsp_name, aspsp_country, status, valid_until, last_synced_at, sync_started_at, last_error, accounts:bank_connection_accounts(provider_account_uid, account_name, currency_code, last_booked_on)")
    .eq("workspace_id", context.workspace.id).in("status", ["active", "expired", "error"]).order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: "Connected banks are unavailable" }, { status: 500 });
  const starts = data.map(connection => connection.sync_started_at).filter((start): start is string => !!start).sort();
  let imports: SyncImport[] = [];
  if (starts.length) {
    const recent = await context.supabase.from("imports").select("id, status, total_rows, new_rows, matched_rows, review_rows, rejected_rows, created_at, mapping")
      .eq("workspace_id", context.workspace.id).gte("created_at", starts[0]).order("created_at");
    if (recent.error) return NextResponse.json({ error: "Connected banks are unavailable" }, { status: 500 });
    imports = recent.data as SyncImport[];
  }
  const connections = data.map(connection => {
    const names = new Set(connection.accounts.map(account => account.account_name));
    const started = connection.sync_started_at ? Date.parse(connection.sync_started_at) : Infinity;
    const own = imports.filter(item => Date.parse(item.created_at) >= started && names.has(item.mapping?.accountName ?? ""));
    return { ...connection, sync: { running: syncRunning(connection), imports: own.map(item => ({ id: item.id, status: item.status, total_rows: item.total_rows, new_rows: item.new_rows, matched_rows: item.matched_rows, review_rows: item.review_rows, rejected_rows: item.rejected_rows })) } };
  });
  return NextResponse.json({ configured: enableBankingConfigured(), connections });
}
