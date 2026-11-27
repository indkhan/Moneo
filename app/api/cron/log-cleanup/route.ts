import { cronRoute } from "@/lib/cron";
import { serviceDb } from "@/lib/service-db";
import { serviceRoleConfig } from "@/lib/env";
import { deleteExpiredLogs } from "@/lib/logs/store";

export const GET = cronRoute(async () => {
  if (!serviceRoleConfig()) return Response.json({ error: "Log service unavailable" }, { status: 503 });
  return Response.json({ removed: await deleteExpiredLogs(serviceDb(), new Date()) });
});
