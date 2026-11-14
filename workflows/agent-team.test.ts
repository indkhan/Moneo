import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentTeam } from "./agent-team";
import { sleep } from "workflow";
import { banksSyncing, finishRun, mergeRun, runAgent, startAnalysis, startRun } from "@/lib/ai/agent-runtime";
import { startAgentRun } from "@/lib/ai/agent-dispatch";
import { maybeStartFirstReview } from "@/lib/import/follow-up";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("workflow", async original => ({ ...await original<typeof import("workflow")>(), getWorkflowMetadata: () => ({ workflowRunId: "wf" }), getStepMetadata: () => ({ attempt: 1 }),
  sleep: vi.fn(async (until: Date) => { calls.push("sleep"); vi.setSystemTime(until); }) }));
vi.mock("@/lib/ai/agent-dispatch", () => ({ startAgentRun: vi.fn() }));
vi.mock("@/lib/import/follow-up", () => ({ maybeStartFirstReview: vi.fn() }));
vi.mock("@/lib/ai/agent-runtime", () => ({
  startRun: vi.fn(async () => [["categorizer"], ["recurring", "budget"], ["forecaster"], ["writer"]]),
  runAgent: vi.fn(),
  mergeRun: vi.fn(async () => { calls.push("merge"); return true; }),
  autoApplyRun: vi.fn(async () => { calls.push("auto"); }),
  startAnalysis: vi.fn(async () => true),
  banksSyncing: vi.fn(async () => false),
  service: () => "db",
  finishRun: vi.fn(async (_run: string, _ws: string, error?: string) => { calls.push(error ? `finish:${error}` : "finish"); return { status: "completed", rerun: null }; }),
}));
beforeEach(() => {
  calls.length = 0; vi.clearAllMocks();
  vi.mocked(banksSyncing).mockResolvedValue(false);
  vi.mocked(runAgent).mockImplementation(async (_run, _ws, agent) => { calls.push(`start:${agent}`); await new Promise(resolve => setTimeout(resolve, agent === "recurring" ? 10 : 1)); calls.push(`end:${agent}`); return "done"; });
  vi.useFakeTimers({ toFake: ["Date"] }).setSystemTime(Date.parse("2026-11-14T06:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });

it("runs a wave in parallel, merges before the writer and finishes once", async () => {
  await agentTeam("run", "ws");
  expect(startRun).toHaveBeenCalledWith("run", "ws", "wf");
  // Both analysts start before the slower one ends: same wave, parallel steps.
  expect(calls.slice(calls.indexOf("auto") + 1, calls.indexOf("auto") + 3).sort()).toEqual(["start:budget", "start:recurring"]);
  expect(calls.indexOf("start:forecaster")).toBeGreaterThan(calls.indexOf("end:recurring"));
  expect(calls.slice(-4)).toEqual(["merge", "start:writer", "end:writer", "finish"]);
});

// The budget coach and recurring detective read categories; they must see the categorizer's changes applied, not pending.
it("applies the categorizer's changes before recurring and budget read categories", async () => {
  await agentTeam("run", "ws");
  expect(calls.slice(0, 3)).toEqual(["start:categorizer", "end:categorizer", "auto"]);
  expect(calls.indexOf("auto")).toBeLessThan(calls.indexOf("start:budget"));
});

it("stops after a wave when the owner cancels, without merging or writing", async () => {
  vi.mocked(banksSyncing).mockResolvedValue(false);
  vi.mocked(runAgent).mockImplementation(async (_run, _ws, agent) => { calls.push(agent); return agent === "recurring" ? "canceled" : "done"; });
  await agentTeam("run", "ws");
  expect(mergeRun).not.toHaveBeenCalled();
  expect(calls).toEqual(["categorizer", "auto", "recurring", "budget", "finish"]);
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
  vi.mocked(banksSyncing).mockResolvedValue(false);
  vi.mocked(runAgent).mockImplementation(async (_run, _ws, agent) => { calls.push(agent); return agent === "categorizer" ? "failed" : "done"; });
  await agentTeam("run", "ws");
  expect(calls).toEqual(["categorizer", "auto", "recurring", "budget", "forecaster", "merge", "writer", "finish"]);
  expect(mergeRun).toHaveBeenCalled();
});

// The daily syncs of three banks each started their own run, and a sync's rows could land after the run had read.
it("a requested pass waits out its debounce and every bank sync still landing before it plans", async () => {
  vi.mocked(banksSyncing).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
  await agentTeam("run", "ws", "2026-11-14T06:03:00Z");
  expect(calls.slice(0, 4)).toEqual(["sleep", "sleep", "sleep", "start:categorizer"]);
  expect(banksSyncing).toHaveBeenCalledTimes(3);
  // A sync that never lets go doesn't hold the pass past its deadline.
  calls.length = 0;
  vi.mocked(banksSyncing).mockResolvedValue(true);
  await agentTeam("run", "ws", "2026-11-14T07:00:00Z");
  expect(Date.now()).toBe(Date.parse("2026-11-14T07:30:00Z"));
  expect(calls).toContain("finish");
});

// Every import and sync ran the anomaly hunter, forecaster and writer again on unchanged data.
it("ends after organizing when nothing changed since the last analysis", async () => {
  vi.mocked(startAnalysis).mockResolvedValueOnce(false);
  await agentTeam("run", "ws");
  expect(calls).toEqual(["start:categorizer", "end:categorizer", "auto", "finish"]);
  expect(mergeRun).not.toHaveBeenCalled();
  expect(maybeStartFirstReview).toHaveBeenCalledWith("db", "ws");
});

it("starts one follow-up pass when rows landed while it worked", async () => {
  vi.mocked(finishRun).mockResolvedValueOnce({ status: "completed", rerun: "sync" });
  await agentTeam("run", "ws");
  expect(startAgentRun).toHaveBeenCalledOnce();
  expect(startAgentRun).toHaveBeenCalledWith("db", "ws", { trigger: "sync" });
  expect(sleep).not.toHaveBeenCalled();
});
