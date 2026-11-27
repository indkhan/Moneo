"use workflow";

import { RetryableError, getStepMetadata, getWorkflowMetadata, sleep } from "workflow";
import { autoApplyRun, banksSyncing, finishRun, mergeRun, runAgent, service, startAnalysis, startRun } from "@/lib/ai/agent-runtime";
import { startAgentRun } from "@/lib/ai/agent-dispatch";
import type { AgentId } from "@/lib/ai/agent-team";
import { maybeStartFirstReview } from "@/lib/import/follow-up";
import { isTransientDbError } from "@/lib/service-db";
import { log, logInfo } from "@/lib/log";

const SYNC_WAIT_MS = 30 * 60_000, SYNC_POLL_MS = 60_000;

export async function agentTeam(runId: string, workspaceId: string, notBefore?: string) {
  "use workflow";
  if (notBefore) {
    await sleep(new Date(notBefore));
    const deadline = Date.parse(notBefore) + SYNC_WAIT_MS;
    while (Date.now() < deadline && await syncingStep(workspaceId)) await sleep(new Date(Math.min(Date.now() + SYNC_POLL_MS, deadline)));
  }
  let error: string | undefined;
  try { if (!await team(runId, workspaceId)) return; }
  catch (cause) { error = String(cause); }
  const { rerun } = await finishStep(runId, workspaceId, error);
  if (rerun) try { await rerunStep(workspaceId, rerun); } catch { hourlyChecksRetryFollowUps(); }
  try { await firstReviewStep(workspaceId); } catch { hourlyChecksRetryFollowUps(); }
}

const hourlyChecksRetryFollowUps = () => {};

async function team(runId: string, workspaceId: string) {
  const waves = await planStep(runId, workspaceId, getWorkflowMetadata().workflowRunId);
  if (!waves) return false;
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
  logInfo("jobs", "agents.start", "Agent team started", { workflowRunId }, { workspaceId, agentRunId: runId });
  return startRun(runId, workspaceId, workflowRunId);
}

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
  log({ level: error ? "error" : "info", area: "jobs", event: "agents.finish", message: error ? "Agent team failed" : "Agent team finished", details: error ? { error } : undefined, workspaceId, agentRunId: runId });
  return finishRun(runId, workspaceId, error);
}

const runStartsWithoutWaitingWhenSyncStateIsUnknown = () => false;

async function syncingStep(workspaceId: string) {
  "use step";
  return banksSyncing(workspaceId).catch(runStartsWithoutWaitingWhenSyncStateIsUnknown);
}

async function rerunStep(workspaceId: string, trigger: "import" | "sync") {
  "use step";
  await startAgentRun(service(), workspaceId, { trigger });
}

async function firstReviewStep(workspaceId: string) {
  "use step";
  await maybeStartFirstReview(service(), workspaceId);
}
