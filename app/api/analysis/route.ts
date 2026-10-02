import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { modelForSettings } from "@/lib/ai/provider";
import { requireAiScope } from "@/lib/settings";
import { startFinancialReview } from "@/lib/finance/start-review";

export async function GET() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const result = await context.supabase.from("background_jobs").select("id, status, stage, error, created_at, updated_at")
    .eq("workspace_id", context.workspace.id).eq("kind", "financial_review").order("created_at", { ascending: false }).limit(20);
  return result.error ? Response.json({ error: result.error.message }, { status: 500 }) : Response.json(result.data);
}

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.OPENROUTER_API_KEY)
    return Response.json({ error: "Financial review service is not configured" }, { status: 503 });
  const parsed = z.object({ requestId: z.uuid() }).strict().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Provide a review request ID" }, { status: 400 });
  try { requireAiScope(context.settings, "accounts", "transactions"); }
  catch (error) { return Response.json({ error: String(error) }, { status: 403 }); }
  try { await modelForSettings(context.settings); }
  catch (error) { return Response.json({ error: String(error) }, { status: 503 }); }
  try {
    const result = await startFinancialReview(context.supabase, context.workspace.id, parsed.data.requestId);
    return Response.json(result, { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not start financial review" }, { status: 503 });
  }
}
