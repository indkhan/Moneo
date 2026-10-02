"use workflow";

import { generateText } from "ai";
import { createClient } from "@supabase/supabase-js";
import { modelForSettings } from "@/lib/ai/provider";
import { loadWorkspaceSettings, requireAiScope, type WorkspaceSettings } from "@/lib/settings";
import { loadFinancialReviewEvidence } from "@/lib/finance/review-loader";

function service() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Financial review service is not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
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
  const evidence = await gatherEvidence(jobId, workspaceId, scheduled);
  if (!evidence) return;
  const body = await writeReview(jobId, workspaceId, evidence, scheduled);
  if (!body) return;
  await saveReview(jobId, workspaceId, evidence, body, scheduled);
}

async function gatherEvidence(jobId: string, workspaceId: string, scheduled: boolean) {
  "use step";
  const db = service();
  const job = await db.from("background_jobs").select("status, cancel_requested").eq("id", jobId).eq("workspace_id", workspaceId).single();
  if (job.error) throw job.error;
  if (["completed", "canceled", "failed"].includes(job.data.status)) return null;
  if (job.data.cancel_requested) {
    await db.from("background_jobs").update({ status: "canceled", stage: "canceled", updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId).in("status", ["queued", "running"]);
    return null;
  }
  await db.from("background_jobs").update({ status: "running", stage: "gathering_evidence", error: null, updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId).in("status", ["queued", "running"]);
  try {
    const settings = await loadWorkspaceSettings(db, workspaceId);
    if (!await summaryStillEnabled(db, jobId, workspaceId, settings, scheduled)) return null;
    requireAiScope(settings, "accounts", "transactions");
    const workspace = await db.from("workspaces").select("id, display_currency").eq("id", workspaceId).single();
    if (workspace.error) throw workspace.error;
    return loadFinancialReviewEvidence(db, { ...workspace.data, timezone: settings.timezone }, settings);
  } catch (error) {
    await db.from("background_jobs").update({ status: "failed", stage: "gathering_evidence", error: String(error), updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId).in("status", ["queued", "running"]);
    throw error;
  }
}

async function writeReview(jobId: string, workspaceId: string, evidence: Awaited<ReturnType<typeof loadFinancialReviewEvidence>>, scheduled: boolean) {
  "use step";
  const db = service();
  const job = await db.from("background_jobs").select("cancel_requested, status").eq("id", jobId).eq("workspace_id", workspaceId).single();
  if (job.error) throw job.error;
  if (["completed", "canceled", "failed"].includes(job.data.status)) return null;
  if (job.data.cancel_requested) {
    await db.from("background_jobs").update({ status: "canceled", stage: "canceled", updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId).in("status", ["queued", "running"]);
    return null;
  }
  await db.from("background_jobs").update({ status: "running", stage: "writing_review", updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId).in("status", ["queued", "running"]);
  try {
    const settings = await loadWorkspaceSettings(db, workspaceId);
    if (!await summaryStillEnabled(db, jobId, workspaceId, settings, scheduled)) return null;
    requireAiScope(settings, "accounts", "transactions");
    if (!("unavailable" in evidence.planning)) requireAiScope(settings, "planning");
    const result = await generateText({ model: await modelForSettings(settings), maxOutputTokens: 2200, maxRetries: 0, abortSignal: AbortSignal.timeout(90_000),
      system: "Write a personal-finance review using only supplied dated evidence. Cover period cashflow, category and merchant changes, budget pressure, confirmed obligations, goals, wealth/debt and forecast when available. Cite exact currency, period and supplied internal source links for numerical claims. Distinguish recorded savings from virtual reservations, booked balances from available funds, historical valuations from current net worth, and assumptions from forecasts. Call unavailable and partial evidence out explicitly. Group changes show evidence, not causes; never invent explanations or financial data. Offer conditional, reviewable next steps rather than certainty.",
      prompt: JSON.stringify(evidence) });
    if (!result.text.trim()) throw new Error("AI returned an empty review");
    return result.text.trim() + (result.finishReason === "length" ? "\n\nIncomplete review: the provider reached its output limit. The saved evidence remains available; further findings may be missing." : "");
  } catch (error) {
    await db.from("background_jobs").update({ status: "failed", stage: "writing_review", error: String(error), updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId).in("status", ["queued", "running"]);
    throw error;
  }
}

async function saveReview(jobId: string, workspaceId: string, evidence: Awaited<ReturnType<typeof loadFinancialReviewEvidence>>, body: string, scheduled: boolean) {
  "use step";
  const db = service();
  const job = await db.from("background_jobs").select("cancel_requested, status").eq("id", jobId).eq("workspace_id", workspaceId).single();
  if (job.error) throw job.error;
  if (["completed", "canceled", "failed"].includes(job.data.status)) return;
  if (job.data.cancel_requested) {
    await db.from("background_jobs").update({ status: "canceled", stage: "canceled", updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId).in("status", ["queued", "running"]);
    return;
  }
  try {
    const settings = await loadWorkspaceSettings(db, workspaceId);
    if (!await summaryStillEnabled(db, jobId, workspaceId, settings, scheduled)) return;
    requireAiScope(settings, "accounts", "transactions");
    if (!("unavailable" in evidence.planning)) requireAiScope(settings, "planning");
    const saved = await db.rpc("finish_financial_review", { p_job_id: jobId, p_workspace_id: workspaceId,
      p_title: `Financial review ${evidence.period.to}`, p_body: body, p_evidence: evidence, p_scheduled: scheduled });
    if (saved.error) throw saved.error;
  } catch (error) {
    await db.from("background_jobs").update({ status: "failed", stage: "saving_review", error: String(error), updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId).in("status", ["queued", "running"]);
    throw error;
  }
}
