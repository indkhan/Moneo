import { serviceDb } from "@/lib/bank/server";
import { scalableConfigured } from "@/lib/scalable/server";
import { syncScalable } from "@/lib/scalable/sync";

export const maxDuration = 300;

// Daily valuation: a Scalable value counts toward today's net worth only when it is dated today.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !scalableConfigured()) return Response.json({ error: "Scalable sync unavailable" }, { status: 503 });
  // ponytail: 100 connections per run, sequential; page and fan out before going multi-user.
  const { data, error } = await serviceDb().from("scalable_connections").select("id, workspace_id").eq("status", "active").order("id").limit(100);
  if (error) return Response.json({ error: "Scalable connections unavailable" }, { status: 503 });
  let synced = 0, failed = 0;
  for (const row of data ?? []) {
    try { await syncScalable(row.id, row.workspace_id); synced++; } catch { failed++; }
  }
  return Response.json({ synced, failed });
}
