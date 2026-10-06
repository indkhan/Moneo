import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { getRun, start } from "workflow/api";
import { financialReview } from "@/workflows/financial-review";

export async function startFinancialReview(db: SupabaseClient, workspaceId: string, requestId: string, chatRequestId?: string) {
  const claimed = await db.rpc("start_financial_review", { p_request_id: requestId, p_chat_request_id: chatRequestId ?? null });
  if (claimed.error) throw claimed.error;
  const { jobId } = claimed.data as { jobId: string };
  const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const readJob = async () => {
    const job = await service.from("background_jobs").select("status, workflow_run_id").eq("id", jobId).eq("workspace_id", workspaceId).eq("kind", "financial_review").single();
    if (job.error) throw job.error;
    return job.data as { status: string; workflow_run_id: string | null };
  };
  let job = await readJob();
  if (!["queued", "running"].includes(job.status)) return { jobId, status: job.status };
  if (job.workflow_run_id) {
    const runtime = await getRun(job.workflow_run_id).status;
    if (["failed", "cancelled", "completed"].includes(runtime)) {
      const failed = await service.rpc("fail_financial_review", { p_job_id: jobId, p_workspace_id: workspaceId, p_run_id: job.workflow_run_id,
        p_stage: "runtime_reconciliation", p_error: `Workflow ${runtime} before application finalization` });
      if (failed.error) throw failed.error;
      job = await readJob();
    }
  } else {
    // An exception may mean the enqueue response was lost. Keep the claim recoverable;
    // the worker self-registers, and repeat dispatches elect one run before useful work.
    const run = await start(financialReview, [jobId, workspaceId]);
    const receipt = await service.rpc("register_financial_review_run", { p_job_id: jobId, p_workspace_id: workspaceId, p_run_id: run.runId });
    if (receipt.error) throw receipt.error;
    if (typeof receipt.data !== "boolean") throw new Error("Invalid financial review dispatch receipt");
    job = await readJob();
  }
  return { jobId, status: job.status };
}
