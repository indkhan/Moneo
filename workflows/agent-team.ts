"use workflow";

import { RetryableError, getStepMetadata, getWorkflowMetadata } from "workflow";
import { autoApplyRun, finishRun, mergeRun, runAgent, startRun } from "@/lib/ai/agent-runtime";
import type { AgentId } from "@/lib/ai/agent-team";
import { isTransientDbError } from "@/lib/service-db";

// Durable agent team. Each agent is its own step, so a crash or redeploy
// resumes after the last finished agent; agents in a wave run in parallel.
export async function agentTeam(runId: string, workspaceId: string) {
  "use workflow";
  try {
    const waves = await planStep(runId, workspaceId, getWorkflowMetadata().workflowRunId);
    if (!waves) return;
    // The last wave (the writer) briefs on what was merged and applied.
    const writers = waves.at(-1) ?? [];
    for (const wave of waves.slice(0, -1)) {
      const results = await Promise.all(wave.map(agent => agentStep(runId, workspaceId, agent as Exclude<AgentId, "lead">)));
      if (results.includes("canceled")) return void await finishStep(runId, workspaceId);
    }
    if (!await mergeStep(runId, workspaceId)) return void await finishStep(runId, workspaceId);
    await autoApplyStep(runId, workspaceId);
    for (const agent of writers) await agentStep(runId, workspaceId, agent as Exclude<AgentId, "lead">);
    await finishStep(runId, workspaceId);
  } catch (error) {
    await finishStep(runId, workspaceId, String(error));
  }
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

async function finishStep(runId: string, workspaceId: string, error?: string) {
  "use step";
  return finishRun(runId, workspaceId, error);
}
