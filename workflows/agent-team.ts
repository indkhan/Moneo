"use workflow";

import { RetryableError, getStepMetadata, getWorkflowMetadata, sleep } from "workflow";
import { autoApplyRun, banksSyncing, finishRun, mergeRun, runAgent, service, startAnalysis, startRun } from "@/lib/ai/agent-runtime";
import { startAgentRun } from "@/lib/ai/agent-dispatch";
import type { AgentId } from "@/lib/ai/agent-team";
import { maybeStartFirstReview } from "@/lib/import/follow-up";
import { isTransientDbError } from "@/lib/service-db";

// A requested pass (after an import or bank sync) waits out its debounce, then for bank syncs still landing rows, up to this long.
const SYNC_WAIT_MS = 30 * 60_000, SYNC_POLL_MS = 60_000;

// Durable agent team. Each agent is its own step, so a crash or redeploy
// resumes after the last finished agent; agents in a wave run in parallel.
export async function agentTeam(runId: string, workspaceId: string, notBefore?: string) {
  "use workflow";
  if (notBefore) {
    // Everything that lands meanwhile joins this queued run, so the daily syncs of every bank get one pass.
    await sleep(new Date(notBefore));
    const deadline = Date.parse(notBefore) + SYNC_WAIT_MS;
    while (Date.now() < deadline && await syncingStep(workspaceId)) await sleep(new Date(Math.min(Date.now() + SYNC_POLL_MS, deadline)));
  }
  let error: string | undefined;
  try { if (!await team(runId, workspaceId)) return; }
  catch (cause) { error = String(cause); }
  const { rerun } = await finishStep(runId, workspaceId, error);
  // Rows that landed while this run worked get one more pass. Neither follow-up is part of the run; the hourly checks retry them.
  if (rerun) try { await rerunStep(workspaceId, rerun); } catch {}
  try { await firstReviewStep(workspaceId); } catch {}
}

/** False when the run was no longer active to begin with. */
async function team(runId: string, workspaceId: string) {
  const waves = await planStep(runId, workspaceId, getWorkflowMetadata().workflowRunId);
  if (!waves) return false;
  // The first wave is the categorizer: its changes are applied before anyone else reads categories, and the
  // analysis runs only when something changed since the last one. The last wave (the writer) briefs on what was merged.
  const writers = waves.at(-1) ?? [];
  for (const [index, wave] of waves.slice(0, -1).entries()) {
    const results = await Promise.all(wave.map(agent => agentStep(runId, workspaceId, agent as Exclude<AgentId, "lead">)));
    if (results.includes("canceled")) return true;
    if (index === 0) {
      await autoApplyStep(runId, workspaceId);
      if (!await analysisStep(runId, workspaceId)) return true;
    }
  }
  if (!await mergeStep(runId, workspaceId)) return true;
  for (const agent of writers) await agentStep(runId, workspaceId, agent as Exclude<AgentId, "lead">);
  return true;
}

async function planStep(runId: string, workspaceId: string, workflowRunId: string) {
  "use step";
  return startRun(runId, workspaceId, workflowRunId);
}

// A dropped database connection is retried with growing pauses; on the last attempt the agent's
// task is marked failed instead, so the rest of the team still runs.
const AGENT_ATTEMPTS = 4;
async function agentStep(runId: string, workspaceId: string, agent: Exclude<AgentId, "lead">) {
  "use step";
  const { attempt } = getStepMetadata();
  try { return await runAgent(runId, workspaceId, agent, attempt < AGENT_ATTEMPTS); }
  catch (error) {
    if (isTransientDbError(error)) throw new RetryableError(String(error).slice(0, 2000), { retryAfter: attempt ** 2 * 2000 });
    throw error;
  }
}
agentStep.maxRetries = AGENT_ATTEMPTS - 1;

async function mergeStep(runId: string, workspaceId: string) {
  "use step";
  return mergeRun(runId, workspaceId);
}

async function autoApplyStep(runId: string, workspaceId: string) {
  "use step";
  return autoApplyRun(runId, workspaceId);
}

async function analysisStep(runId: string, workspaceId: string) {
  "use step";
  return startAnalysis(runId, workspaceId);
}

async function finishStep(runId: string, workspaceId: string, error?: string) {
  "use step";
  return finishRun(runId, workspaceId, error);
}

// A failed check never holds the queued run (and with it every later pass): it just stops waiting.
async function syncingStep(workspaceId: string) {
  "use step";
  return banksSyncing(workspaceId).catch(() => false);
}

async function rerunStep(workspaceId: string, trigger: "import" | "sync") {
  "use step";
  await startAgentRun(service(), workspaceId, { trigger });
}

async function firstReviewStep(workspaceId: string) {
  "use step";
  await maybeStartFirstReview(service(), workspaceId);
}
