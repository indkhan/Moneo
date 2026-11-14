import { beforeEach, expect, it, vi } from "vitest";
import { start } from "workflow/api";
import { startAgentRun } from "./agent-dispatch";

vi.mock("workflow/api", () => ({ start: vi.fn(), getRun: vi.fn() }));
vi.mock("@/workflows/agent-team", () => ({ agentTeam: () => undefined }));
vi.mock("@/lib/settings", () => ({ loadWorkspaceSettings: async () => ({ ai_data_scopes: ["accounts", "transactions", "planning"] }) }));

// agent_runs with its two unique indexes: one run per import, and one queued/running run per workspace.
type Run = { id: string; workspace_id: string; import_id: string | null; trigger: string; status: string };
let runs: Run[];
let rivalBeforeInsert: Run | null;
const active = (run: Run) => run.status === "queued" || run.status === "running";
const db = { from: () => {
  const where: [keyof Run, unknown][] = [];
  const rows = () => runs.filter(run => where.every(([column, value]) => Array.isArray(value) ? value.includes(run[column]) : run[column] === value));
  const query = {
    select: () => query, limit: () => query,
    eq: (column: keyof Run, value: unknown) => { where.push([column, value]); return query; },
    in: (column: keyof Run, value: unknown[]) => { where.push([column, value]); return query; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
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

it("a file import arriving during a bank sync's run reuses that run instead of starting a second", async () => {
  runs.push({ id: "sync-run", workspace_id: "w1", import_id: null, trigger: "sync", status: "running" });
  expect(await startAgentRun(db, "w1", { importId: "import-1" })).toBe("sync-run");
  expect(runs).toHaveLength(1);
  expect(start).not.toHaveBeenCalled();
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
