import { serviceClient } from "@/lib/service-db";
import { startBacklogRun } from "@/lib/ai/agent-dispatch";
import { maybeStartFirstReview } from "@/lib/import/follow-up";

export const maxDuration = 60;

// Hourly: rows a failed agent run left uncategorized, that arrived after the last run, or that a plan limit left
// blank once it resets, get another run; and the first review starts here once its 24-hour deadline passed.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return Response.json({ error: "Agent service unavailable" }, { status: 503 });
  const db = serviceClient(url, key);
  // ponytail: one owner means one workspace; page beyond 100 before expanding beyond personal use.
  const { data, error } = await db.from("workspaces").select("id").order("id").limit(100);
  if (error) return Response.json({ error: "Workspaces unavailable" }, { status: 503 });
  let started = 0, failed = 0;
  for (const row of data ?? []) {
    try { if (await startBacklogRun(db, row.id)) started++; }
    catch { failed++; } // The next hour tries again.
    try { await maybeStartFirstReview(db, row.id); } catch { failed++; }
  }
  return Response.json({ started, failed }, { status: failed ? 503 : 200 });
}
