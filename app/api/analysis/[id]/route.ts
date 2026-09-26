import { createClient } from "@supabase/supabase-js";
import { requireWorkspace } from "@/lib/auth";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const { id } = await params;
  const job = await context.supabase.from("background_jobs").select("id, status, stage, error, created_at, updated_at")
    .eq("id", id).eq("workspace_id", context.workspace.id).eq("kind", "financial_review").maybeSingle();
  if (job.error) return Response.json({ error: job.error.message }, { status: 500 });
  if (!job.data) return Response.json({ error: "Review not found" }, { status: 404 });
  const analysis = job.data.status === "completed" ? await context.supabase.from("saved_analyses")
    .select("id, title, body, evidence, created_at").eq("job_id", id).eq("workspace_id", context.workspace.id).maybeSingle() : null;
  if (analysis?.error) return Response.json({ error: analysis.error.message }, { status: 500 });
  return Response.json({ ...job.data, analysis: analysis?.data ?? null });
}

export async function DELETE(_request: Request, { params }: Context) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    return Response.json({ error: "Financial review service is not configured" }, { status: 503 });
  const { id } = await params;
  const ownJob = await context.supabase.from("background_jobs").select("id, status")
    .eq("id", id).eq("workspace_id", context.workspace.id).eq("kind", "financial_review").maybeSingle();
  if (ownJob.error) return Response.json({ error: ownJob.error.message }, { status: 500 });
  if (!ownJob.data) return Response.json({ error: "Review not found" }, { status: 404 });
  if (!["queued", "running"].includes(ownJob.data.status)) return Response.json({ status: ownJob.data.status });
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await db.from("background_jobs").update({ cancel_requested: true, updated_at: new Date().toISOString() })
    .eq("id", id).eq("workspace_id", context.workspace.id).in("status", ["queued", "running"]);
  return result.error ? Response.json({ error: result.error.message }, { status: 500 }) : Response.json({ status: "cancel_requested" });
}
