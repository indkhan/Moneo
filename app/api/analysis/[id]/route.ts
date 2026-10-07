import { requireWorkspace } from "@/lib/auth";
import { reviewFreshness } from "@/lib/finance/review-freshness";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const { id } = await params;
  const job = await context.supabase.from("background_jobs").select("id, status, stage, cancel_requested, error, created_at, updated_at")
    .eq("id", id).eq("workspace_id", context.workspace.id).eq("kind", "financial_review").maybeSingle();
  if (job.error) return Response.json({ error: job.error.message }, { status: 500 });
  if (!job.data) return Response.json({ error: "Review not found" }, { status: 404 });
  const analysis = job.data.status === "completed" ? await context.supabase.from("saved_analyses")
    .select("id, title, body, evidence, created_at").eq("job_id", id).eq("workspace_id", context.workspace.id).maybeSingle() : null;
  if (analysis?.error) return Response.json({ error: analysis.error.message }, { status: 500 });
  const saved = analysis?.data;
  const freshness = saved ? await reviewFreshness(context.supabase, context.workspace, saved.evidence) : null;
  return Response.json({ ...job.data, analysis: saved ? { ...saved, freshness } : null });
}

export async function DELETE(_request: Request, { params }: Context) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const { id } = await params;
  const result = await context.supabase.rpc("cancel_financial_review", { p_job_id: id });
  return result.error ? Response.json({ error: result.error.message }, { status: result.error.code === "P0002" ? 404 : 400 }) : Response.json({ status: result.data });
}
