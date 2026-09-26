import { createClient } from "@supabase/supabase-js";
import { start } from "workflow/api";
import { requireWorkspace } from "@/lib/auth";
import { getModel } from "@/lib/ai/provider";
import { financialReview } from "@/workflows/financial-review";

export async function GET() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const result = await context.supabase.from("background_jobs").select("id, status, stage, error, created_at, updated_at")
    .eq("workspace_id", context.workspace.id).eq("kind", "financial_review").order("created_at", { ascending: false }).limit(20);
  return result.error ? Response.json({ error: result.error.message }, { status: 500 }) : Response.json(result.data);
}

export async function POST() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.OPENROUTER_API_KEY)
    return Response.json({ error: "Financial review service is not configured" }, { status: 503 });
  try { getModel(); }
  catch (error) { return Response.json({ error: String(error) }, { status: 503 }); }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const inserted = await db.from("background_jobs").insert({ workspace_id: context.workspace.id, kind: "financial_review" }).select("id").single();
  if (inserted.error) return Response.json({ error: inserted.error.message }, { status: 500 });
  try {
    await start(financialReview, [inserted.data.id, context.workspace.id]);
    return Response.json({ jobId: inserted.data.id, status: "queued" }, { status: 202 });
  } catch (error) {
    await db.from("background_jobs").update({ status: "failed", stage: "starting", error: String(error) }).eq("id", inserted.data.id).eq("workspace_id", context.workspace.id);
    return Response.json({ error: "Could not start financial review", jobId: inserted.data.id }, { status: 503 });
  }
}
