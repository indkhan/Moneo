import { serviceDb } from "@/lib/bank/server";
import { calendarDate } from "@/lib/finance/calendar";
import { loadWorkspaceSettings } from "@/lib/settings";
import { scalableConfigured } from "@/lib/scalable/server";
import { syncScalable } from "@/lib/scalable/sync";

export const maxDuration = 300;

// Daily valuation: each hourly run syncs what isn't dated today yet in the workspace's timezone, so a
// new day needs no waiting and a failed sync retries next hour. Older values still count, flagged.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !scalableConfigured()) return Response.json({ error: "Scalable sync unavailable" }, { status: 503 });
  // ponytail: 100 connections per run, sequential; page and fan out before going multi-user.
  const db = serviceDb();
  const { data, error } = await db.from("scalable_connections").select("id, workspace_id, last_synced_at").eq("status", "active").order("id").limit(100);
  if (error) return Response.json({ error: "Scalable connections unavailable" }, { status: 503 });
  let synced = 0, failed = 0;
  for (const row of data ?? []) {
    try {
      const { timezone } = await loadWorkspaceSettings(db, row.workspace_id);
      if (row.last_synced_at && calendarDate(row.last_synced_at, timezone) === calendarDate(new Date(), timezone)) continue;
      await syncScalable(row.id, row.workspace_id); synced++;
    } catch { failed++; }
  }
  return Response.json({ synced, failed });
}
