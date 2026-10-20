import { beforeEach, expect, it, vi } from "vitest";
import { agentTeam } from "./agent-team";
import { finishRun, mergeRun, runAgent, startRun } from "@/lib/ai/agent-runtime";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("workflow", async original => ({ ...await original<typeof import("workflow")>(), getWorkflowMetadata: () => ({ workflowRunId: "wf" }) }));
vi.mock("@/lib/ai/agent-runtime", () => ({
  startRun: vi.fn(async () => [["categorizer", "recurring"], ["forecaster"], ["writer"]]),
  runAgent: vi.fn(async (_run: string, _ws: string, agent: string) => { calls.push(`start:${agent}`); await new Promise(resolve => setTimeout(resolve, agent === "categorizer" ? 10 : 1)); calls.push(`end:${agent}`); return "done"; }),
  mergeRun: vi.fn(async () => { calls.push("merge"); return true; }),
  autoApplyRun: vi.fn(async () => { calls.push("auto"); }),
  finishRun: vi.fn(async (_run: string, _ws: string, error?: string) => { calls.push(error ? `finish:${error}` : "finish"); return "completed"; }),
}));
beforeEach(() => { calls.length = 0; vi.clearAllMocks(); });

it("runs a wave in parallel, merges and auto-applies before the writer and finishes once", async () => {
  await agentTeam("run", "ws");
  expect(startRun).toHaveBeenCalledWith("run", "ws", "wf");
  // Both analysts start before the slower one ends: same wave, parallel steps.
  expect(calls.slice(0, 2).sort()).toEqual(["start:categorizer", "start:recurring"]);
  expect(calls.indexOf("start:forecaster")).toBeGreaterThan(calls.indexOf("end:categorizer"));
  expect(calls.slice(-5)).toEqual(["merge", "auto", "start:writer", "end:writer", "finish"]);
});

it("stops after a wave when the owner cancels, without merging or writing", async () => {
  vi.mocked(runAgent).mockImplementation(async (_run, _ws, agent) => { calls.push(agent); return agent === "recurring" ? "canceled" : "done"; });
  await agentTeam("run", "ws");
  expect(mergeRun).not.toHaveBeenCalled();
  expect(calls).toEqual(["categorizer", "recurring", "finish"]);
  expect(finishRun).toHaveBeenCalledWith("run", "ws", undefined);
});

it("does nothing for an inactive run and records unexpected failures", async () => {
  vi.mocked(startRun).mockResolvedValueOnce(null);
  await agentTeam("run", "ws");
  expect(runAgent).not.toHaveBeenCalled();
  expect(finishRun).not.toHaveBeenCalled();
  vi.mocked(startRun).mockRejectedValueOnce(new Error("db down"));
  await agentTeam("run", "ws");
  expect(finishRun).toHaveBeenCalledWith("run", "ws", "Error: db down");
});

it("a failed agent does not stop the rest of the team", async () => {
  vi.mocked(runAgent).mockImplementation(async (_run, _ws, agent) => { calls.push(agent); return agent === "categorizer" ? "failed" : "done"; });
  await agentTeam("run", "ws");
  expect(calls).toEqual(["categorizer", "recurring", "forecaster", "merge", "auto", "writer", "finish"]);
  expect(mergeRun).toHaveBeenCalled();
});
