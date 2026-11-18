import { cronRoute } from "@/lib/cron";
import { serviceClient } from "@/lib/service-db";
import { startBacklogRun } from "@/lib/ai/agent-dispatch";
import { maybeStartFirstReview } from "@/lib/import/follow-up";
import { serviceRoleConfig } from "@/lib/env";

export const maxDuration = 60;

export const GET = cronRoute(async () => {
  const service = serviceRoleConfig();
  if (!service) return Response.json({ error: "Agent service unavailable" }, { status: 503 });
  const db = serviceClient(service.url, service.key);
  const { data, error } = await db.from("workspaces").select("id").order("id").limit(100);
  if (error) return Response.json({ error: "Workspaces unavailable" }, { status: 503 });
  let started = 0, failed = 0;
  for (const row of data ?? []) {
    try { if (await startBacklogRun(db, row.id)) started++; }
    catch { failed++; }
    try { await maybeStartFirstReview(db, row.id); } catch { failed++; }
  }
  return Response.json({ started, failed }, { status: failed ? 503 : 200 });
});
