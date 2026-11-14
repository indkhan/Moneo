import { beforeEach, expect, it, vi } from "vitest";
import { autoApplyRun, finishRun, recoverStuckProposals, runAgent } from "@/lib/ai/agent-runtime";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const db = vi.hoisted(() => ({ run: {} as Record<string, unknown>, settings: {} as Record<string, unknown>, tasks: [] as Record<string, unknown>[], ledger: [] as Record<string, unknown>[],
  writes: [] as { table: string; op: string; value: unknown }[], dropOnce: null as null | { table: string; op: string }, proposals: [] as Record<string, unknown>[],
  rpcs: [] as { name: string; args: Record<string, unknown> }[] }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: vi.fn(async () => { throw new Error("no model in tests"); }) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  rpc: async (name: string, args: Record<string, unknown>) => { db.rpcs.push({ name, args }); return { data: name === "apply_ai_organization" ? { applied: 1, transactionIds: [id(10)], skipped: {} } : false, error: null }; },
  from: (table: string) => {
    const filters: Record<string, unknown> = {};
    let op = "select", value: unknown;
    const rows = () => table === "agent_tasks" ? db.tasks.filter(task => !filters.agent || task.agent === filters.agent) : table === "transactions" ? db.ledger
      : table === "agent_proposals" ? db.proposals.filter(row => !filters.id || row.id === filters.id) : [];
    const result = () => {
      if (db.dropOnce?.table === table && db.dropOnce.op === op) { db.dropOnce = null; return { data: null, error: { message: "rest is not reachable" } }; }
      if (op !== "select") { db.writes.push({ table, op, value }); if (table === "agent_proposals" && op === "update") { for (const row of rows()) Object.assign(row, value); return { data: rows()[0] ?? null, error: null }; } if (table === "agent_tasks" && op === "update") for (const task of rows()) Object.assign(task, value); if (table === "agent_tasks" && op === "insert") db.tasks.push(...([value].flat() as Record<string, unknown>[]).map(row => ({ events: [], ...row }))); return { data: null, error: null }; }
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
  db.settings = {}; db.tasks = []; db.writes = []; db.dropOnce = null; db.proposals = []; db.rpcs = [];
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

// The desktop gateway dropped one request ("rest is not reachable") and the agent was marked failed for good.
it("a dropped database call leaves the agent for its step to retry, and the retry finishes the work", async () => {
  db.tasks = [{ agent: "anomaly", status: "pending", events: [] }];
  db.dropOnce = { table: "agent_proposals", op: "upsert" };
  await expect(runAgent(id(9), id(1), "anomaly", true)).rejects.toThrow("rest is not reachable");
  expect(db.tasks[0].status).toBe("running");
  expect(await runAgent(id(9), id(1), "anomaly", true)).toBe("done");
  expect(db.writes.filter(write => write.op === "upsert")).toHaveLength(1);
  // On the last attempt the failure stays inside the task so the rest of the team continues.
  db.tasks = [{ agent: "anomaly", status: "pending", events: [] }];
  db.dropOnce = { table: "agent_proposals", op: "upsert" };
  expect(await runAgent(id(9), id(1), "anomaly", false)).toBe("failed");
});

it("a run with a failed agent finishes failed, so it can be resumed and the backlog check retries it", async () => {
  db.tasks = [{ agent: "categorizer", status: "failed", events: [] }, { agent: "anomaly", status: "done", events: [] }, { agent: "writer", status: "done", events: [] }];
  expect(await finishRun(id(9), id(1))).toMatchObject({ status: "failed" });
  expect(db.writes.find(write => write.table === "agent_runs")!.value).toMatchObject({ status: "failed", error: expect.any(String) });
  db.tasks = [{ agent: "categorizer", status: "done", events: [] }]; db.writes = [];
  expect(await finishRun(id(9), id(1))).toMatchObject({ status: "completed" });
});

it("returns proposals stuck in applying: landed changes are accepted, the rest wait again", async () => {
  const proposals = [{ id: id(70), workspace_id: id(1), kind: "categorize", status: "applying" }, { id: id(71), workspace_id: id(1), kind: "categorize", status: "applying" }];
  const reviews = [{ id: id(80), workspace_id: id(1), proposal_id: id(70), transaction_id: id(90) }];
  const filters: Record<string, [string, unknown][]> = {};
  const fake = { from: (table: string) => {
    const where: [string, unknown][] = filters[table] = [];
    let patch: Record<string, unknown> | null = null;
    const rows = () => (table === "agent_proposals" ? proposals : reviews).filter(row => where.every(([column, value]) => Array.isArray(value) ? value.includes(row[column as "id"]) : row[column as "id"] === value));
    const query = { select: () => query, lt: (column: string, value: unknown) => { filters[`${table}.lt`] = [[column, value]]; return query; },
      eq: (column: string, value: unknown) => { where.push([column, value]); return query; }, in: (column: string, value: unknown) => { where.push([column, value]); return query; },
      update: (value: Record<string, unknown>) => { patch = value; return query; },
      then: (resolve: (value: unknown) => unknown) => { if (patch) rows().forEach(row => Object.assign(row, patch)); return Promise.resolve({ data: rows(), error: null }).then(resolve); } };
    return query;
  } };
  await recoverStuckProposals(fake as never, id(1), Date.parse("2026-11-13T12:00:00Z"));
  expect(filters["agent_proposals.lt"]).toEqual([["decided_at", "2026-11-13T11:55:00.000Z"]]);
  expect(proposals[0]).toMatchObject({ status: "accepted", result: { auto: true, applied: 1, href: `/money/transactions?transaction=${id(90)}` } });
  expect(proposals[1]).toMatchObject({ status: "proposed", decided_at: null });
});

// The old auto-apply wrote every Categorizer proposal as the owner's correction and saved it as an owner rule.
it("auto-applies only high and medium confidence as AI labels and leaves low confidence for the owner", async () => {
  const payload = (n: number) => ({ rows: [{ id: id(n), version: 2 }], patch: { category_id: id(60) }, merchantName: n === 11 ? "Cafe Luna" : null, ruleKey: "cafe luna", evidence: [], identityKey: "cafe luna", ...(n === 10 ? { source: "rule" } : {}) });
  const evidence = { facts: [{ label: "Basis", value: "Consistent history" }], transactions: [], links: [] };
  db.proposals = [[id(80), 10, 95], [id(81), 11, 60], [id(82), 12, 45]].map(([pid, n, confidence]) => ({ id: pid, payload: payload(n as number), notes: [], confidence, evidence, status: "proposed" }));
  await autoApplyRun(id(9), id(1));
  expect(db.rpcs.map(call => call.name)).toEqual(["apply_ai_organization", "apply_ai_organization"]);
  expect(db.rpcs[0].args).toEqual({ p_workspace: id(1), p_run: id(9), p_proposal: id(80), p_items: [{ transaction_id: id(10), expected_version: 2, category_id: id(60), merchant_id: null,
    merchant_name: null, confidence: "high", reason: "Consistent history", identity_key: "cafe luna", source: "rule" }] });
  expect(db.rpcs[1].args.p_items).toEqual([expect.objectContaining({ transaction_id: id(11), merchant_name: "Cafe Luna", confidence: "medium", source: "ai" })]);
  expect(db.proposals.map(row => row.status)).toEqual(["accepted", "accepted", "proposed"]);
  expect(db.proposals[0].result).toMatchObject({ auto: true, applied: 1 });
});
