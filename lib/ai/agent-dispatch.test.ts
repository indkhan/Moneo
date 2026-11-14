import { beforeEach, expect, it, vi } from "vitest";
import { start } from "workflow/api";
import { PASS_DEBOUNCE_MS, startAgentRun } from "./agent-dispatch";

vi.mock("workflow/api", () => ({ start: vi.fn(), getRun: vi.fn() }));
vi.mock("@/workflows/agent-team", () => ({ agentTeam: () => undefined }));
vi.mock("@/lib/settings", () => ({ loadWorkspaceSettings: async () => ({ ai_data_scopes: ["accounts", "transactions", "planning"] }) }));

// agent_runs with its two unique indexes: one run per import, and one queued/running run per workspace.
type Run = { id: string; workspace_id: string; import_id: string | null; trigger: string; status: string; rerun_trigger?: string };
let runs: Run[];
let rivalBeforeInsert: Run | null;
const active = (run: Run) => run.status === "queued" || run.status === "running";
const db = { from: () => {
  const where: [keyof Run, unknown][] = [];
  let patch: Partial<Run> | null = null;
  const rows = () => runs.filter(run => where.every(([column, value]) => Array.isArray(value) ? value.includes(run[column]) : run[column] === value));
  const query = {
    select: () => query, limit: () => query,
    eq: (column: keyof Run, value: unknown) => { where.push([column, value]); return query; },
    in: (column: keyof Run, value: unknown[]) => { where.push([column, value]); return query; },
    maybeSingle: async () => { const [row] = rows(); if (row && patch) Object.assign(row, patch); return { data: row ?? null, error: null }; },
    update: (value: Partial<Run>) => { patch = value; return query; },
    insert: (row: Omit<Run, "id" | "status">) => ({ select: () => ({ single: async () => {
      if (rivalBeforeInsert) { runs.push(rivalBeforeInsert); rivalBeforeInsert = null; }
      const run = { id: `run-${runs.length + 1}`, status: "queued", ...row };
      if (runs.some(other => other.workspace_id === run.workspace_id && active(other)) || (run.import_id && runs.some(other => other.import_id === run.import_id)))
        return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      runs.push(run);
      return { data: run, error: null };
    } }) }),
  };
  return query;
} } as never;

beforeEach(() => { runs = []; rivalBeforeInsert = null; vi.clearAllMocks(); });

// Three bank syncs and a CSV import within minutes started a run each, and each ran every analysis agent and the writer.
it("collapses imports and syncs landing within the debounce into one waiting run", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }).setSystemTime(Date.parse("2026-11-14T06:00:00Z"));
  const ids = [await startAgentRun(db, "w1", { trigger: "sync" }), await startAgentRun(db, "w1", { trigger: "sync" }),
    await startAgentRun(db, "w1", { importId: "import-1" }), await startAgentRun(db, "w1", { trigger: "sync" })];
  expect(new Set(ids)).toEqual(new Set(["run-1"]));
  expect(runs).toHaveLength(1);
  expect(start).toHaveBeenCalledOnce();
  expect(vi.mocked(start).mock.calls[0][1]).toEqual(["run-1", "w1", new Date(Date.now() + PASS_DEBOUNCE_MS).toISOString()]);
  vi.useRealTimers();
});

// Rows landing after a run's categorizer read waited an hour for the backlog check.
it("marks a working run when rows land, so it starts exactly one follow-up", async () => {
  runs.push({ id: "sync-run", workspace_id: "w1", import_id: null, trigger: "sync", status: "running" });
  expect(await startAgentRun(db, "w1", { importId: "import-1" })).toBe("sync-run");
  expect(await startAgentRun(db, "w1", { trigger: "sync" })).toBe("sync-run");
  expect(runs).toEqual([expect.objectContaining({ id: "sync-run", rerun_trigger: "sync" })]);
  expect(start).not.toHaveBeenCalled();
  // A manual start joins the working run without asking for another.
  runs[0].rerun_trigger = undefined;
  expect(await startAgentRun(db, "w1")).toBe("sync-run");
  expect(runs[0].rerun_trigger).toBeUndefined();
});

it("two starts racing for an idle workspace end up on one run", async () => {
  // The other start checked, inserted and won between this start's check and its insert.
  rivalBeforeInsert = { id: "rival", workspace_id: "w1", import_id: null, trigger: "sync", status: "queued" };
  expect(await startAgentRun(db, "w1", { importId: "import-1" })).toBe("rival");
  rivalBeforeInsert = { id: "rival-2", workspace_id: "w2", import_id: null, trigger: "backlog", status: "queued" };
  expect(await startAgentRun(db, "w2", { trigger: "sync" })).toBe("rival-2");
  expect(start).not.toHaveBeenCalled();
  expect(await startAgentRun(db, "w3", { trigger: "sync" })).toBe("run-3");
  expect(start).toHaveBeenCalledOnce();
});
