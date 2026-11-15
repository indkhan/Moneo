import { cronRoute } from "@/lib/cron";
import { serviceDb } from "@/lib/bank/server";
import { calendarDate } from "@/lib/finance/calendar";
import { loadWorkspaceSettings } from "@/lib/settings";
import { scalableConfigured } from "@/lib/scalable/server";
import { syncScalable } from "@/lib/scalable/sync";

export const maxDuration = 300;

export const GET = cronRoute(async () => {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !scalableConfigured()) return Response.json({ error: "Scalable sync unavailable" }, { status: 503 });
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
});
