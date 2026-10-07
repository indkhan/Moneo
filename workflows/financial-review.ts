"use workflow";

import { APICallError, generateText } from "ai";
import { createClient } from "@supabase/supabase-js";
import { setTimeout as delay } from "node:timers/promises";
import { FatalError, RetryableError, getStepMetadata, getWorkflowMetadata } from "workflow";
import { getRun } from "workflow/api";
import { modelForSettings } from "@/lib/ai/provider";
import { loadWorkspaceSettings, requireAiScope, type WorkspaceSettings } from "@/lib/settings";
import { loadFinancialReviewEvidence } from "@/lib/finance/review-loader";
import { captureToolEvidence } from "@/lib/finance/capture-evidence";
import { loadEvidenceReceipt, evidenceFingerprint, type EvidenceReceipt } from "@/lib/finance/evidence-receipts";
import {gatherReviewInvestigation} from "@/lib/finance/review-gather";
import {resolveReviewRequest, scheduledReviewRequest} from "@/lib/finance/review-request";
import type {ReviewProgress} from "@/lib/finance/review-controller";
import {buildReviewPrompt} from "@/lib/finance/review-prompt";
import {synthesizeReview} from "@/lib/finance/review-synthesis";
import { FINANCIAL_ANSWER_INSTRUCTIONS, providerFinancialAnswer } from "@/lib/finance/tool-evidence";
import type { requireWorkspace } from "@/lib/auth";

function service(signal?: AbortSignal) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new FatalError("Financial review service is not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, ...(signal ? {global: {fetch: (input, init) =>
    fetch(input, {...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])})}} : {}) });
}

async function checkpointReview(db: ReturnType<typeof service>, jobId: string, workspaceId: string, runId: string, progress: ReviewProgress) {
  const saved = await db.rpc("checkpoint_financial_investigation", {p_job_id: jobId, p_workspace_id: workspaceId, p_run_id: runId, p_progress: progress});
  if (saved.error) throw saved.error;
  if (saved.data !== true) throw new FatalError("Investigation is no longer active");
}

function reviewScopes(settings: WorkspaceSettings, planning = false, imports = false) {
  try { requireAiScope(settings, "accounts", "transactions", ...(planning ? ["planning" as const] : []), ...(imports ? ["imports" as const] : [])); }
  catch (error) { throw new FatalError(String(error)); }
}

function retryFailure(error: unknown): never {
  if (error instanceof FatalError) throw error;
  if (APICallError.isInstance(error) && !error.isRetryable) throw new FatalError(error.message);
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (["22023", "42501", "28000", "P0002"].includes(String(code))) throw new FatalError(String(error));
  throw new RetryableError(String(error).slice(0, 2000), { retryAfter: getStepMetadata().attempt ** 2 * 1000 });
}

async function enterStage(db: ReturnType<typeof service>, jobId: string, workspaceId: string, runId: string, stage: string) {
  const job = await db.from("background_jobs").select("status, cancel_requested, workflow_run_id").eq("id", jobId).eq("workspace_id", workspaceId).single();
  if (job.error) throw job.error;
  if (["completed", "canceled", "failed"].includes(job.data.status) || job.data.workflow_run_id !== runId && !(job.data.workflow_run_id === null && job.data.cancel_requested)) return false;
  const value = job.data.cancel_requested ? { status: "canceled", stage: "canceled" } : { status: "running", stage };
  const update = db.from("background_jobs").update({ ...value, error: null, updated_at: new Date().toISOString() })
    .eq("id", jobId).eq("workspace_id", workspaceId).in("status", ["queued", "running"])
    .eq("cancel_requested", job.data.cancel_requested);
  const changed = await (job.data.workflow_run_id === null ? update.is("workflow_run_id", null) : update.eq("workflow_run_id", runId)).select("id").maybeSingle();
  if (changed.error) throw changed.error;
  // The current step has no active provider work at these stage boundaries.
  // Persist its acknowledgment before fencing future runtime steps.
  if (changed.data && job.data.cancel_requested) await getRun(runId).cancel();
  return Boolean(changed.data) && !job.data.cancel_requested;
}

async function registerRun(jobId: string, workspaceId: string, runId: string) {
  "use step";
  try {
    const receipt = await service().rpc("register_financial_review_run", { p_job_id: jobId, p_workspace_id: workspaceId, p_run_id: runId });
    if (receipt.error) throw receipt.error;
    if (typeof receipt.data !== "boolean") throw new FatalError("Invalid financial review run receipt");
    if (!receipt.data) await enterStage(service(), jobId, workspaceId, runId, "starting");
    return receipt.data;
  } catch (error) { retryFailure(error); }
}

async function failReview(jobId: string, workspaceId: string, runId: string, stage: string, error: string) {
  "use step";
  try {
    const failed = await service().rpc("fail_financial_review", { p_job_id: jobId, p_workspace_id: workspaceId, p_run_id: runId, p_stage: stage, p_error: error.slice(0, 2000) });
    if (failed.error) throw failed.error;
    if (!["queued", "running", "failed", "completed", "canceled"].includes(failed.data)) throw new FatalError("Invalid financial review failure receipt");
  } catch (failure) { retryFailure(failure); }
}

async function summaryStillEnabled(db: ReturnType<typeof service>, jobId: string, workspaceId: string, settings: WorkspaceSettings, scheduled: boolean) {
  if (!scheduled) return true;
  const receipt = await db.from("summary_runs").select("cadence").eq("job_id", jobId).eq("workspace_id", workspaceId).maybeSingle();
  if (receipt.error) throw receipt.error;
  if (!receipt.data || receipt.data.cadence === settings.summary_cadence) return true;
  const canceled = await db.from("background_jobs").update({ status: "canceled", stage: "canceled", error: null,
    updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId).in("status", ["queued", "running"]);
  if (canceled.error) throw canceled.error;
  return false;
}

export async function financialReview(jobId: string, workspaceId: string, scheduled = false) {
  "use workflow";
  const runId = getWorkflowMetadata().workflowRunId;
  let stage = "starting";
  try {
    if (!await registerRun(jobId, workspaceId, runId)) return;
    stage = "gathering_evidence";
    const evidence = await gatherEvidence(jobId, workspaceId, scheduled, runId);
    if (!evidence) return;
    stage = "writing_review";
    const body = await writeReview(jobId, workspaceId, evidence, scheduled, runId);
    if (!body) return;
    stage = "saving_review";
    await saveReview(jobId, workspaceId, evidence, body, scheduled, runId);
  } catch (error) {
    await failReview(jobId, workspaceId, runId, stage, String(error));
    throw error;
  }
}

async function gatherEvidence(jobId: string, workspaceId: string, scheduled: boolean, runId: string) {
  "use step";
  try {
    const db = service();
    if (!await enterStage(db, jobId, workspaceId, runId, "gathering_evidence")) return null;
    const settings = await loadWorkspaceSettings(db, workspaceId);
    if (!await summaryStillEnabled(db, jobId, workspaceId, settings, scheduled)) return null;
    reviewScopes(settings);
    const job = await db.from("background_jobs").select("review_request, review_progress").eq("id", jobId).eq("workspace_id", workspaceId).single();
    if (job.error) throw job.error;
    let request = job.data.review_request ? resolveReviewRequest(job.data.review_request, job.data.review_request.query.period.to) : null;
    if (!request && scheduled) {
      const cadence = await db.from("summary_runs").select("cadence,period_start").eq("job_id", jobId).eq("workspace_id", workspaceId).single();
      if (cadence.error) throw cadence.error;
      if (!["weekly", "monthly"].includes(cadence.data.cadence) || !cadence.data.period_start) throw new FatalError("Scheduled review period is unavailable");
      request = scheduledReviewRequest(cadence.data.cadence, cadence.data.period_start);
    }
    if (request) {
      const stopped = new AbortController(), finished = new AbortController();
      let monitorError: unknown;
      const monitor = (async () => {
        while (!finished.signal.aborted) {
          await delay(500, undefined, {signal: finished.signal});
          const current = await db.from("background_jobs").select("status,cancel_requested,workflow_run_id").eq("id", jobId).eq("workspace_id", workspaceId)
            .abortSignal(AbortSignal.any([finished.signal, AbortSignal.timeout(2000)])).single();
          if (finished.signal.aborted) return;
          if (current.error) throw current.error;
          if (current.data.cancel_requested || current.data.workflow_run_id !== runId || !["queued", "running"].includes(current.data.status)) {
            stopped.abort(new Error("Investigation stopped")); return;
          }
        }
      })().catch(error => {if (!finished.signal.aborted) {monitorError = error; stopped.abort(error);}});
      try {
        const progress = await gatherReviewInvestigation(request, {workspaceId, client: service, signal: stopped.signal,
          checkpoint: value => checkpointReview(db, jobId, workspaceId, runId, value)}, job.data.review_progress ?? undefined);
        if (monitorError) throw monitorError;
        if (!await enterStage(db, jobId, workspaceId, runId, "gathering_evidence")) return null;
        return {period: request.query.period, sourceCoverage: {importStatuses: null}, planning: {unavailable: "Planning evidence was not included in this query."},
          reviewInvestigation: {request, progress}, verification: {version: 1, method: "structured-evidence-v1", receiptIds: [...new Set(progress.queries.flatMap(query => query.receiptId ? [query.receiptId] : []))]}};
      } catch (error) {
        // The reader settles its actual HTTP transport before cancellation is acknowledged.
        if (stopped.signal.aborted && !monitorError && !await enterStage(db, jobId, workspaceId, runId, "gathering_evidence")) return null;
        throw error;
      } finally {finished.abort(); await monitor;}
    }
    const workspace = await db.from("workspaces").select("id, display_currency").eq("id", workspaceId).single();
    if (workspace.error) throw workspace.error;
    const raw = await loadFinancialReviewEvidence(db, { ...workspace.data, timezone: settings.timezone }, settings);
    const captureContext = { supabase: db, workspace: { ...workspace.data, id: workspaceId, timezone: settings.timezone }, settings } as Awaited<ReturnType<typeof requireWorkspace>>;
    const receipts = await captureToolEvidence("reviews_investigate", {}, raw, captureContext, db);
    // Full calculation inputs and supporting rows remain in immutable receipts,
    // while the original dated review snapshot stays within its publication bound.
    const summary = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "calculationEvidence")) as Omit<typeof raw, "calculationEvidence">;
    return { ...summary, verification: { version: 1, method: "structured-evidence-v1", receiptIds: receipts.map(receipt => receipt.id) } };
  } catch (error) {
    retryFailure(error);
  }
}

async function writeReview(jobId: string, workspaceId: string, evidence: NonNullable<Awaited<ReturnType<typeof gatherEvidence>>>, scheduled: boolean, runId: string) {
  "use step";
  const stopped = new AbortController();
  const finished = new AbortController();
  let monitoring: Promise<void> | undefined;
  let monitoringError: unknown;
  try {
    const db = service();
    if (!await enterStage(db, jobId, workspaceId, runId, "writing_review")) return null;
    const settings = await loadWorkspaceSettings(db, workspaceId);
    if (!await summaryStillEnabled(db, jobId, workspaceId, settings, scheduled)) return null;
    reviewScopes(settings, !("unavailable" in evidence.planning), evidence.sourceCoverage?.importStatuses != null);
    const receipts: EvidenceReceipt[] = [];
    for (const id of evidence.verification.receiptIds) {
      const receipt = await loadEvidenceReceipt(db, workspaceId, id);
      if (!receipt) throw new FatalError("Retained review evidence is unavailable");
      requireAiScope(settings, ...receipt.scopes);
      receipts.push(receipt);
    }
    const model = await modelForSettings(settings, { effort: "minimal", exclude: true });
    // Recheck after asynchronous preparation, before submitting financial context.
    if (!await enterStage(db, jobId, workspaceId, runId, "writing_review")) return null;
    monitoring = (async () => {
      while (!finished.signal.aborted) {
        await delay(500, undefined, { signal: finished.signal });
        const job = await db.from("background_jobs").select("status, cancel_requested, workflow_run_id")
          .eq("id", jobId).eq("workspace_id", workspaceId).abortSignal(AbortSignal.any([finished.signal, AbortSignal.timeout(2000)])).single();
        if (finished.signal.aborted) return;
        if (job.error) throw job.error;
        if (job.data.cancel_requested || job.data.workflow_run_id !== runId || !["queued", "running"].includes(job.data.status)) {
          stopped.abort(new Error("Financial review stopped"));
          return;
        }
      }
    })().catch(error => {
      if (!finished.signal.aborted) { monitoringError = error; stopped.abort(error); }
    });
    if (evidence.reviewInvestigation) {
      const current = await db.from("background_jobs").select("review_progress").eq("id", jobId).eq("workspace_id", workspaceId).single();
      if (current.error) throw current.error;
      const progress: ReviewProgress = current.data.review_progress ?? evidence.reviewInvestigation.progress;
      const priorityIds = evidence.reviewInvestigation.progress.queries.flatMap(query => query.result?.groups.flatMap(group =>
        ["current", "comparison", "delta"].map(kind => `${evidenceFingerprint(group.key).slice(0, 32)}:${kind}`)) ?? []);
      const input = buildReviewPrompt(evidence.reviewInvestigation.request, receipts, progress.limitations,
        `Answer the retained question within its exact dated query and focus using supplied evidence. ${FINANCIAL_ANSWER_INSTRUCTIONS}`, priorityIds);
      const result = await synthesizeReview(progress, input, {signal: stopped.signal,
        checkpoint: value => checkpointReview(db, jobId, workspaceId, runId, value), generate: options => generateText({model, ...options})});
      if (monitoringError) throw monitoringError;
      if (!await enterStage(db, jobId, workspaceId, runId, "writing_review")) return null;
      return providerFinancialAnswer(result.text ?? "{}", receipts, workspaceId).body +
        (result.limitation ? `\n\n${result.limitation}` : "") + (progress.limitations.length ? `\n\n${progress.limitations.join("\n\n")}` : "");
    }
    const result = await generateText({ model, maxOutputTokens: 4000, maxRetries: 0, abortSignal: AbortSignal.any([stopped.signal, AbortSignal.timeout(90_000)]),
      system: `Write a personal-finance review using only supplied dated evidence. Cover cashflow, material changes, budgets, obligations, goals, wealth/debt and forecasts when retained measures are available. ${FINANCIAL_ANSWER_INSTRUCTIONS}`,
      prompt: JSON.stringify({ datedReviewSnapshot: evidence, evidenceReceipts: receipts.map(receipt => ({ id: receipt.id, metrics: receipt.metrics })) }) });
    if (monitoringError) throw monitoringError;
    if (!await enterStage(db, jobId, workspaceId, runId, "writing_review")) return null;
    return providerFinancialAnswer(result.text, receipts, workspaceId).body + (result.finishReason === "length" ? "\n\nIncomplete review: the provider reached its output limit. The saved evidence remains available; further findings may be missing." : "");
  } catch (error) {
    // Awaiting generateText above ensures its application transport has settled
    // before a cancellation can become acknowledged in the application row.
    if (stopped.signal.aborted && !monitoringError && !await enterStage(service(), jobId, workspaceId, runId, "writing_review")) return null;
    retryFailure(error);
  } finally {
    finished.abort();
    await monitoring;
  }
}

async function saveReview(jobId: string, workspaceId: string, evidence: NonNullable<Awaited<ReturnType<typeof gatherEvidence>>>, body: string, scheduled: boolean, runId: string) {
  "use step";
  try {
    const db = service();
    if (!await enterStage(db, jobId, workspaceId, runId, "saving_review")) return;
    const settings = await loadWorkspaceSettings(db, workspaceId);
    if (!await summaryStillEnabled(db, jobId, workspaceId, settings, scheduled)) return;
    reviewScopes(settings, !("unavailable" in evidence.planning), evidence.sourceCoverage?.importStatuses != null);
    let publicationEvidence = evidence;
    if (evidence.reviewInvestigation) {
      const current = await db.from("background_jobs").select("review_progress").eq("id", jobId).eq("workspace_id", workspaceId).single();
      if (current.error) throw current.error;
      if (!current.data.review_progress) throw new FatalError("Retained investigation progress is unavailable");
      publicationEvidence = {...evidence, reviewInvestigation: {...evidence.reviewInvestigation, progress: current.data.review_progress}};
    }
    const saved = await db.rpc("finish_financial_review", { p_job_id: jobId, p_workspace_id: workspaceId,
      p_title: `Financial review ${evidence.period.to}`, p_body: body, p_evidence: publicationEvidence, p_scheduled: scheduled });
    if (saved.error) throw saved.error;
    if (!["completed", "canceled"].includes(saved.data)) throw new FatalError("Financial review publication was not completed or canceled");
  } catch (error) {
    retryFailure(error);
  }
}

// Explicitly bound every durable attempt, including dispatch registration and terminal cleanup.
registerRun.maxRetries = 3;
gatherEvidence.maxRetries = 3;
writeReview.maxRetries = 3;
saveReview.maxRetries = 3;
failReview.maxRetries = 3;
