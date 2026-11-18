import { cronRoute } from "@/lib/cron";
import { serviceClient } from "@/lib/service-db";
import { recoverFinancialReviews } from "@/lib/finance/start-review";
import { serviceRoleConfig } from "@/lib/env";

export const maxDuration = 60;

export const GET = cronRoute(async () => {
  const service = serviceRoleConfig();
  if (!service) return Response.json({ error: "Review recovery unavailable" }, { status: 503 });
  const db = serviceClient(service.url, service.key);
  try {
    const result = await recoverFinancialReviews(db);
    return Response.json(result, { status: result.errors ? 503 : 200 });
  } catch { return Response.json({ error: "Review recovery unavailable" }, { status: 503 }); }
});
