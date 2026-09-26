"use workflow";

import { generateText } from "ai";
import { createClient } from "@supabase/supabase-js";
import { getModel } from "@/lib/ai/provider";
import { buildReviewEvidence } from "@/lib/finance/review";

function service() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Financial review service is not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function financialReview(jobId: string, workspaceId: string) {
  "use workflow";
  const evidence = await gatherEvidence(jobId, workspaceId);
  if (!evidence) return;
  const body = await writeReview(jobId, workspaceId, evidence);
  if (!body) return;
  await saveReview(jobId, workspaceId, evidence, body);
}

async function gatherEvidence(jobId: string, workspaceId: string) {
  "use step";
  const db = service();
  const job = await db.from("background_jobs").select("status, cancel_requested").eq("id", jobId).eq("workspace_id", workspaceId).single();
  if (job.error) throw job.error;
  if (job.data.status === "completed" || job.data.status === "canceled") return null;
  if (job.data.cancel_requested) {
    await db.from("background_jobs").update({ status: "canceled", stage: "canceled", updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId);
    return null;
  }
  await db.from("background_jobs").update({ status: "running", stage: "gathering_evidence", error: null, updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId);
  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10);
    const accounts = await db.from("accounts").select("id, name, currency_code", { count: "exact" }).eq("workspace_id", workspaceId).limit(10000);
    const snapshots = await db.from("balance_snapshots").select("account_id, amount_minor, currency_code, as_of, provenance", { count: "exact" }).eq("workspace_id", workspaceId).lte("as_of", new Date().toISOString()).limit(10000);
    if (accounts.error || snapshots.error) throw accounts.error ?? snapshots.error;
    if (accounts.count !== accounts.data.length || snapshots.count !== snapshots.data.length) throw new Error("Review evidence exceeds the current 10,000-row limit");
    const transactions: { amount_minor: string; currency_code: string; status: string; kind: string }[] = [];
    // ponytail: 10k-row ceiling; add a database aggregate if real workspaces outgrow it.
    for (let offset = 0; offset <= 10000; offset += 500) {
      const page = await db.from("transactions").select("amount_minor, currency_code, status, kind")
        .eq("workspace_id", workspaceId).gte("posted_on", from).lte("posted_on", to)
        .order("id").range(offset, offset + 499);
      if (page.error) throw page.error;
      if (offset === 10000 && page.data.length) throw new Error("Review evidence exceeds the current 10,000-row limit");
      transactions.push(...page.data);
      if (page.data.length < 500) break;
    }
    return buildReviewEvidence(accounts.data, snapshots.data, transactions, from, to);
  } catch (error) {
    await db.from("background_jobs").update({ status: "failed", stage: "gathering_evidence", error: String(error), updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId);
    throw error;
  }
}

async function writeReview(jobId: string, workspaceId: string, evidence: ReturnType<typeof buildReviewEvidence>) {
  "use step";
  const db = service();
  const job = await db.from("background_jobs").select("cancel_requested, status").eq("id", jobId).eq("workspace_id", workspaceId).single();
  if (job.error) throw job.error;
  if (job.data.status === "completed" || job.data.status === "canceled") return null;
  if (job.data.cancel_requested) {
    await db.from("background_jobs").update({ status: "canceled", stage: "canceled", updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId);
    return null;
  }
  await db.from("background_jobs").update({ status: "running", stage: "writing_review", updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId);
  try {
    const result = await generateText({ model: getModel(), maxOutputTokens: 1200,
      system: "Write a concise personal-finance review using only the supplied evidence. Cite the exact account or currency and date period for every numerical claim. Call unknown balances unknown, keep currencies separate, and do not guess missing data. Give useful observations and limitations, not recommendations presented as certainty.",
      prompt: JSON.stringify(evidence) });
    if (!result.text.trim()) throw new Error("AI returned an empty review");
    return result.text.trim();
  } catch (error) {
    await db.from("background_jobs").update({ status: "failed", stage: "writing_review", error: String(error), updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId);
    throw error;
  }
}

async function saveReview(jobId: string, workspaceId: string, evidence: ReturnType<typeof buildReviewEvidence>, body: string) {
  "use step";
  const db = service();
  const job = await db.from("background_jobs").select("cancel_requested, status").eq("id", jobId).eq("workspace_id", workspaceId).single();
  if (job.error) throw job.error;
  if (job.data.status === "completed" || job.data.status === "canceled") return;
  if (job.data.cancel_requested) {
    await db.from("background_jobs").update({ status: "canceled", stage: "canceled", updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId);
    return;
  }
  try {
    const saved = await db.from("saved_analyses").upsert({ workspace_id: workspaceId, job_id: jobId,
      title: `Financial review ${evidence.period.to}`, body, evidence }, { onConflict: "job_id", ignoreDuplicates: true });
    if (saved.error) throw saved.error;
    const completed = await db.from("background_jobs").update({ status: "completed", stage: "completed", error: null, updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId);
    if (completed.error) throw completed.error;
  } catch (error) {
    await db.from("background_jobs").update({ status: "failed", stage: "saving_review", error: String(error), updated_at: new Date().toISOString() }).eq("id", jobId).eq("workspace_id", workspaceId);
    throw error;
  }
}
