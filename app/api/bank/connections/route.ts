import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/auth";
import { enableBankingConfigured } from "@/lib/bank/enable-banking";

// Connected banks for the UI. RLS plus the column grant keep the encrypted session out of reach.
export async function GET() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const { data, error } = await context.supabase.from("bank_connections")
    .select("id, aspsp_name, aspsp_country, status, valid_until, last_synced_at, last_error, accounts:bank_connection_accounts(provider_account_uid, account_name, currency_code, last_booked_on)")
    .eq("workspace_id", context.workspace.id).in("status", ["active", "expired", "error"]).order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: "Connected banks are unavailable" }, { status: 500 });
  return NextResponse.json({ configured: enableBankingConfigured(), connections: data });
}
