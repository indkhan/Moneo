import { serviceDb } from "@/lib/bank/server";
import { calendarDate } from "@/lib/finance/calendar";
import { rebuildScalableHistory } from "@/lib/scalable/history-job";
import { scalableConfigured } from "@/lib/scalable/server";
import { loadWorkspaceSettings } from "@/lib/settings";

export const maxDuration = 300;

// Works out past Scalable values for connections without a good history yet, one try per workspace day.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !scalableConfigured()) return Response.json({ error: "Scalable history unavailable" }, { status: 503 });
  const db = serviceDb();
  const { data, error } = await db.from("scalable_connections").select("id, workspace_id, portfolio, history_status, history_checked_on").eq("status", "active").order("id").limit(100);
  if (error) return Response.json({ error: "Scalable connections unavailable" }, { status: 503 });
  const counts = { saved: 0, failed: 0, skipped: 0 };
  for (const row of data ?? []) {
    try {
      const { timezone } = await loadWorkspaceSettings(db, row.workspace_id);
      const today = calendarDate(new Date(), timezone);
      if (row.history_status === "ok" || row.history_checked_on === today) continue;
      counts[await rebuildScalableHistory(row, timezone, today)]++;
    } catch { counts.failed++; }
  }
  return Response.json(counts);
}
