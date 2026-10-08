import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { modelForSettings } from "@/lib/ai/provider";
import { requireAiScope } from "@/lib/settings";
import { startFinancialReview } from "@/lib/finance/start-review";
import {reviewRequestSchema, resolveReviewRequest} from "@/lib/finance/review-request";
import {calendarDate} from "@/lib/finance/calendar";

export async function GET() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const result = await context.supabase.from("background_jobs").select("id, status, stage, cancel_requested, error, created_at, updated_at")
    .eq("workspace_id", context.workspace.id).eq("kind", "financial_review").order("created_at", { ascending: false }).limit(20);
  return result.error ? Response.json({ error: result.error.message }, { status: 500 }) : Response.json(result.data);
}

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.OPENROUTER_API_KEY)
    return Response.json({ error: "Financial review service is not configured" }, { status: 503 });
  const parsed = z.object({ requestId: z.uuid(), investigation: reviewRequestSchema.optional() }).strict().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Provide a valid review request ID and bounded investigation scope" }, { status: 400 });
  const specification = resolveReviewRequest({...parsed.data.investigation ?? {version: 1, question: "Review my finances"}, allowedScopes: context.settings.ai_data_scopes}, calendarDate(new Date(), context.settings.timezone));
  try { requireAiScope(context.settings, "accounts", "transactions", ...(specification.includePlanning ? ["planning" as const] : [])); }
  catch (error) { return Response.json({ error: String(error) }, { status: 403 }); }
  try { await modelForSettings(context.settings); }
  catch (error) { return Response.json({ error: String(error) }, { status: 503 }); }
  try {
    const result = await startFinancialReview(context.supabase, context.workspace.id, parsed.data.requestId, undefined, specification);
    return Response.json(result, { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not start financial review" }, { status: 503 });
  }
}
