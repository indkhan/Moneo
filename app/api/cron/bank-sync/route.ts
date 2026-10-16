import { start } from "workflow/api";
import { enableBankingConfigured } from "@/lib/bank/enable-banking";
import { serviceDb } from "@/lib/bank/server";
import { syncBankConnection } from "@/workflows/bank-sync";

export const maxDuration = 60;

// Background sync without PSU headers; vercel.json keeps it well under the ~4/day PSD2 allowance.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !enableBankingConfigured()) return Response.json({ error: "Bank sync unavailable" }, { status: 503 });
  // ponytail: 100 connections per run is plenty for personal use; page before going multi-user.
  const { data, error } = await serviceDb().from("bank_connections").select("id, workspace_id").eq("status", "active").order("id").limit(100);
  if (error) return Response.json({ error: "Bank connections unavailable" }, { status: 503 });
  let started = 0, failed = 0;
  for (const row of data ?? []) {
    try { await start(syncBankConnection, [row.id, row.workspace_id]); started++; }
    catch { failed++; }
  }
  return Response.json({ started, failed });
}
