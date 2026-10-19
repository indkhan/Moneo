"use workflow";

import { getWorkflowMetadata } from "workflow";
import { autoApplyRun, finishRun, mergeRun, runAgent, startRun } from "@/lib/ai/agent-runtime";
import type { AgentId } from "@/lib/ai/agent-team";

// Durable agent team. Each agent is its own step, so a crash or redeploy
// resumes after the last finished agent; agents in a wave run in parallel.
export async function agentTeam(runId: string, workspaceId: string) {
  "use workflow";
  try {
    const waves = await planStep(runId, workspaceId, getWorkflowMetadata().workflowRunId);
    if (!waves) return;
    const [analysts, builders, writers] = waves;
    for (const wave of [analysts, builders]) {
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

async function agentStep(runId: string, workspaceId: string, agent: Exclude<AgentId, "lead">) {
  "use step";
  return runAgent(runId, workspaceId, agent);
}

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
