import { cronRoute } from "@/lib/cron";
import { serviceClient } from "@/lib/service-db";
import { recoverFinancialReviews } from "@/lib/finance/start-review";

export const maxDuration = 60;

export const GET = cronRoute(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return Response.json({ error: "Review recovery unavailable" }, { status: 503 });
  const db = serviceClient(url, key);
  try {
    const result = await recoverFinancialReviews(db);
    return Response.json(result, { status: result.errors ? 503 : 200 });
  } catch { return Response.json({ error: "Review recovery unavailable" }, { status: 503 }); }
});
