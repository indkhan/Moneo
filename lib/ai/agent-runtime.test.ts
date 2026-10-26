import { beforeEach, expect, it, vi } from "vitest";
import { runAgent } from "@/lib/ai/agent-runtime";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const db = vi.hoisted(() => ({ run: {} as Record<string, unknown>, settings: {} as Record<string, unknown>, tasks: [] as Record<string, unknown>[], ledger: [] as Record<string, unknown>[],
  writes: [] as { table: string; op: string; value: unknown }[] }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: vi.fn(async () => { throw new Error("no model in tests"); }) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  rpc: async () => ({ data: false, error: null }),
  from: (table: string) => {
    const filters: Record<string, unknown> = {};
    let op = "select", value: unknown;
    const rows = () => table === "agent_tasks" ? db.tasks.filter(task => !filters.agent || task.agent === filters.agent) : table === "transactions" ? db.ledger : [];
    const result = () => {
      if (op !== "select") { db.writes.push({ table, op, value }); if (table === "agent_tasks" && op === "update") for (const task of rows()) Object.assign(task, value); if (table === "agent_tasks" && op === "insert") db.tasks.push(...([value].flat() as Record<string, unknown>[]).map(row => ({ events: [], ...row }))); return { data: null, error: null }; }
      if (table === "agent_runs") return { data: db.run, error: null };
      if (table === "workspaces") return { data: { id: id(1), display_currency: "EUR" }, error: null };
      if (table === "workspace_settings") return { data: db.settings, error: null };
      return { data: rows(), error: null, count: rows().length };
    };
    const query: Record<string, unknown> = {};
    for (const name of ["select", "neq", "gte", "order", "or", "in", "gt", "lt", "limit", "is"]) query[name] = () => query;
    query.eq = (column: string, target: unknown) => { filters[column] = target; return query; };
    for (const name of ["update", "insert", "upsert", "delete"]) query[name] = (input: unknown) => { op = name; value = input; return query; };
    query.single = async () => { const value = result(); return Array.isArray(value.data) ? { ...value, data: value.data[0] } : value; };
    query.maybeSingle = query.single;
    query.range = async () => result();
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return query;
  },
}) }));
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://synthetic.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic"); vi.stubEnv("OPENAI_API_KEY", "");
  db.run = { status: "running", cancel_requested: false, model_status: "disabled", import_id: null };
  db.settings = {}; db.tasks = []; db.writes = [];
  db.ledger = [...Array.from({ length: 12 }, (_, n) => ({ id: id(n + 10), version: 1, posted_on: `2026-08-${String(n + 1).padStart(2, "0")}`, description: `SHOP ${n}`, amount_minor: "-2000" })),
    { id: id(40), version: 1, posted_on: "2026-10-01", description: "CAFE LUNA", amount_minor: "-450" }, { id: id(41), version: 1, posted_on: "2026-10-01", description: "CAFE LUNA", amount_minor: "-450" }]
    .map(row => ({ ...row, currency_code: "EUR", account_id: id(2), category_id: null, merchant_id: null, kind: "ordinary", status: "posted", review_reasons: [] }));
});

it("an agent streams its steps, writes only proposals, and finishes with a summary", async () => {
  db.tasks = [{ agent: "anomaly", status: "pending", events: [] }];
  expect(await runAgent(id(9), id(1), "anomaly")).toBe("done");
  const upsert = db.writes.find(write => write.op === "upsert")!;
  expect(upsert.table).toBe("agent_proposals");
  expect(upsert.value).toEqual([expect.objectContaining({ kind: "finding", conflict_key: `duplicate:${id(40)}:${id(41)}`, run_id: id(9), workspace_id: id(1) })]);
  expect(db.writes.every(write => write.table.startsWith("agent_"))).toBe(true);
  expect(db.tasks[0]).toMatchObject({ status: "done", summary: "1 findings from 14 postings" });
  expect((db.tasks[0].events as { type: string }[]).map(event => event.type)).toEqual(["step", "tool", "finding", "step"]);
});

it("respects Settings scopes, stops when canceled and never reruns finished agents", async () => {
  db.settings = { ai_data_scopes: ["accounts"] };
  db.tasks = [{ agent: "anomaly", status: "pending", events: [] }];
  expect(await runAgent(id(9), id(1), "anomaly")).toBe("failed");
  expect(db.tasks[0].events).toEqual([expect.objectContaining({ text: "Failed: AI access to transactions is disabled in Settings" })]);
  db.tasks = [{ agent: "anomaly", status: "done", events: [] }];
  expect(await runAgent(id(9), id(1), "anomaly")).toBe("done");
  expect(db.writes.filter(write => write.op === "upsert")).toEqual([]);
  db.run = { ...db.run, cancel_requested: true };
  expect(await runAgent(id(9), id(1), "anomaly")).toBe("canceled");
});
