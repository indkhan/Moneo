import { createClient } from "@supabase/supabase-js";
import { recoverFinancialReviews } from "@/lib/finance/start-review";

export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return Response.json({ error: "Review recovery unavailable" }, { status: 503 });
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const result = await recoverFinancialReviews(db);
    return Response.json(result, { status: result.errors ? 503 : 200 });
  } catch { return Response.json({ error: "Review recovery unavailable" }, { status: 503 }); }
}
