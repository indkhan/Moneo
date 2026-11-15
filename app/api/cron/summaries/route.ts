import { cronRoute } from "@/lib/cron";
import { serviceClient } from "@/lib/service-db";
import { dispatchFinancialReview } from "@/lib/finance/start-review";
import { settingsSchema } from "@/lib/settings";
import { dueSummaryPeriod } from "@/lib/summary-schedule";

export const maxDuration = 60;

export const GET = cronRoute(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return Response.json({ error: "Summary service unavailable" }, { status: 503 });
  const db = serviceClient(url, key);
  const { data, error, count } = await db.from("workspace_settings").select("*", { count: "exact" }).neq("summary_cadence", "none").order("workspace_id").limit(500);
  if (error) return Response.json({ error: "Summary preferences unavailable" }, { status: 503 });
  let started = 0, failed = 0, invalid = 0;
  for (const row of data ?? []) {
    if (started >= 25) break;
    const preferences = settingsSchema.safeParse(row);
    if (!preferences.success) { invalid++; continue; }
    const due = dueSummaryPeriod(preferences.data);
    if (!due) continue;
    const claimed = await db.rpc("claim_scheduled_summary", { p_workspace_id: row.workspace_id, p_cadence: due.cadence, p_period_start: due.periodStart });
    if (claimed.error) { failed++; continue; }
    if (!claimed.data) continue;
    try { await dispatchFinancialReview(db, claimed.data, row.workspace_id, true); started++; }
    catch { failed++; }
  }
  return Response.json({ started, failed, invalid, capacityExceeded: (count ?? 0) > 500 });
});
