import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { getRun, start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { financialReview } from "@/workflows/financial-review";

export async function startFinancialReview(db: SupabaseClient, workspaceId: string, requestId: string, chatRequestId?: string) {
  const claimed = await db.rpc("start_financial_review", { p_request_id: requestId, p_chat_request_id: chatRequestId ?? null });
  if (claimed.error) throw claimed.error;
  const { jobId } = claimed.data as { jobId: string };
  const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  return dispatchFinancialReview(service, jobId, workspaceId, false);
}

// All origins share the same receipt election and terminal reconciliation.
export async function dispatchFinancialReview(service: SupabaseClient, jobId: string, workspaceId: string, scheduled?: boolean) {
  const readJob = async () => {
    const job = await service.from("background_jobs").select("status, workflow_run_id, cancel_requested, created_at, dispatched_at, updated_at").eq("id", jobId).eq("workspace_id", workspaceId).eq("kind", "financial_review").single();
    if (job.error) throw job.error;
    return job.data as { status: string; workflow_run_id: string | null; cancel_requested: boolean; created_at: string; dispatched_at: string | null; updated_at: string };
  };
  let job = await readJob();
  if (!["queued", "running"].includes(job.status)) return { jobId, status: job.status };
  if (job.workflow_run_id) {
    const run = getRun(job.workflow_run_id);
    // Resilient start can acknowledge before the runtime record is materialized.
    // Never mistake a transport error or an active retry for a missing run.
    const exists = await run.exists;
    let runtime = exists ? await run.status : "missing";
    // A business deadline for abandoned reviews, separate from step retries/timeouts.
    // Never fail an active application row until the runtime acknowledges stopping.
    const expired = Date.now() - Date.parse(job.dispatched_at ?? job.created_at) >= 24 * 60 * 60 * 1000;
    const deadlineCancellation = exists && expired && ["pending", "running"].includes(runtime);
    if (deadlineCancellation) {
      await run.cancel();
      runtime = await run.status;
      if (!["failed", "cancelled", "completed"].includes(runtime)) throw new Error("Financial review deadline cancellation was not acknowledged");
    }
    if (["failed", "cancelled", "completed"].includes(runtime) || !exists && expired) {
      let cancellationUnconfirmed = false;
      // run.cancel() fences future steps but does not abort an in-flight fetch.
      // Give the worker time to acknowledge. A stale running step converges to
      // a terminal business receipt with explicit unconfirmed termination.
      if (runtime === "cancelled" && job.cancel_requested) {
        const canceledAt = await run.completedAt;
        const steps = await getWorld().steps.list({ runId: job.workflow_run_id, resolveData: "none", pagination: { limit: 1000 } });
        if (steps.hasMore || steps.data.some(step => step.status === "running")) {
          if (!canceledAt && !expired || canceledAt && Date.now() - canceledAt.getTime() < 120_000) return { jobId, status: job.status };
          cancellationUnconfirmed = true;
        }
      }
      const failed = await service.rpc("fail_financial_review", { p_job_id: jobId, p_workspace_id: workspaceId, p_run_id: job.workflow_run_id,
        p_stage: cancellationUnconfirmed ? "cancellation_unconfirmed" : deadlineCancellation ? "runtime_deadline" : "runtime_reconciliation",
        p_error: deadlineCancellation ? `Financial review exceeded the 24-hour dispatch deadline; Workflow ${runtime}` : `Workflow ${runtime} before application finalization` });
      if (failed.error) throw failed.error;
      if (!["queued", "running", "failed", "completed", "canceled"].includes(failed.data)) throw new Error("Invalid financial review reconciliation receipt");
      job = await readJob();
    }
  } else if (job.cancel_requested) {
    const canceled = await service.from("background_jobs").update({ status: "canceled", stage: "canceled", error: null, updated_at: new Date().toISOString() })
      .eq("id", jobId).eq("workspace_id", workspaceId).eq("kind", "financial_review").is("workflow_run_id", null).eq("cancel_requested", true).in("status", ["queued", "running"]);
    if (canceled.error) throw canceled.error;
    job = await readJob();
  } else if (Date.now() - Date.parse(job.created_at) >= 24 * 60 * 60 * 1000) {
    // An unknown delivery cannot do useful work without registering first. The
    // null-receipt guard elects terminal expiry against any late registration.
    const expired = await service.from("background_jobs").update({ status: "failed", stage: "dispatch_deadline", error: "Financial review dispatch was not acknowledged within 24 hours", updated_at: new Date().toISOString() })
      .eq("id", jobId).eq("workspace_id", workspaceId).eq("kind", "financial_review").is("workflow_run_id", null).eq("cancel_requested", false).in("status", ["queued", "running"]);
    if (expired.error) throw expired.error;
    job = await readJob();
  } else {
    if (scheduled === undefined) {
      const receipt = await service.from("summary_runs").select("cadence").eq("job_id", jobId).eq("workspace_id", workspaceId).maybeSingle();
      if (receipt.error) throw receipt.error;
      scheduled = Boolean(receipt.data);
    }
    // An exception may mean the enqueue response was lost. Keep the claim recoverable;
    // the worker self-registers, and repeat dispatches elect one run before useful work.
    const run = await start(financialReview, [jobId, workspaceId, scheduled]);
    const receipt = await service.rpc("register_financial_review_run", { p_job_id: jobId, p_workspace_id: workspaceId, p_run_id: run.runId });
    if (receipt.error) throw receipt.error;
    if (typeof receipt.data !== "boolean") throw new Error("Invalid financial review dispatch receipt");
    job = await readJob();
  }
  return { jobId, status: job.status };
}

export async function recoverFinancialReviews(service: SupabaseClient) {
  const candidates = await service.from("background_jobs").select("id, workspace_id, workflow_run_id, updated_at", { count: "exact" })
    .eq("kind", "financial_review").in("status", ["queued", "running"]).order("updated_at").order("id").limit(25);
  if (candidates.error) throw candidates.error;
  let recovered = 0, errors = 0;
  await Promise.all((candidates.data ?? []).map(async (job) => {
    let unsuccessful = false;
    try {
      const result = await dispatchFinancialReview(service, job.id, job.workspace_id);
      if (!["queued", "running"].includes(result.status) || !job.workflow_run_id) recovered++;
    } catch { unsuccessful = true; }
    try {
      // Rotate even broken runtime lookups so they cannot pin the oldest page.
      // Runtime liveness/deadlines use Workflow and immutable receipt/claim dates.
      const observed = await service.from("background_jobs").update({ updated_at: new Date().toISOString() })
        .eq("id", job.id).eq("workspace_id", job.workspace_id).eq("updated_at", job.updated_at).in("status", ["queued", "running"]);
      if (observed.error) throw observed.error;
    } catch { unsuccessful = true; }
    if (unsuccessful) errors++;
  }));
  return { scanned: candidates.data?.length ?? 0, recovered, errors, remaining: Math.max(0, (candidates.count ?? 0) - 25) };
}
