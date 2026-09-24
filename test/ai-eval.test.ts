import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter, withTenant } from "../apps/web/src/tenancy.ts";
import { addEvalCase, createEvalRun, evaluateProtocolCase, finalizeEvalRun, runDeterministicProtocol, runLiveEvaluation, type EvalCategory } from "../apps/web/src/ai-eval.ts";
import { cancelTurn, createThread, getThread, processChatJob, readActivity, retryTurn, sendTurn } from "../apps/web/src/chat.ts";
import { balanceSnapshot } from "../apps/web/src/commands/accounts.ts";
import { confirmProposal, createProposal } from "../apps/web/src/ai-action-proposals.ts";
import { randomUUID } from "node:crypto";
import { ensureTestPool } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
let server: Server;
const sessionSecret = randomBytes(32).toString("hex");

async function fixture() {
  const config: AuthConfig = { issuer: stub.base, clientId: STUB_CLIENT_ID, clientSecret: STUB_CLIENT_SECRET, appBaseUrl: "http://127.0.0.1:1", sessionSecret, sessionTtlSec: 43200 };
  server = createApp(createAuthRouter(config, pool), createTenancyRouter(pool, (req) => requestSession(pool, sessionSecret, req)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.appBaseUrl = base;
  const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const callback = (await fetch(`${login.headers.get("location")!}&login_as=synthetic-ai-eval`, { redirect: "manual" })).headers.get("location")!;
  const cookie = (await fetch(callback, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0];
  const workspace = await (await fetch(`${base}/api/workspaces`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Evaluation", baseCurrency: "EUR" }) })).json() as { id: string };
  const userId = (await pool.query("SELECT id FROM users WHERE auth_subject = 'synthetic-ai-eval'")).rows[0].id as string;
  const account = await (await fetch(`${base}/api/accounts`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: workspace.id, name: "Evaluation account" }) })).json() as { id: string };
  return { userId, workspaceId: workspace.id, accountId: account.id };
}

beforeAll(async () => {
  pool = await ensureTestPool("E04-S07", "moneo_e04_eval", ["ai_eval_summaries", "ai_eval_cases", "ai_eval_runs", "workspace_members", "workspaces", "users", "app_sessions"]);
  stub = await startStubIssuer();
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (stub) await stub.close();
  if (pool) await pool.end();
});

describe("e04-s07 frozen deterministic evaluation", () => {
  it("runs the predeclared 40-case category matrix and persists a 100% protocol summary", async () => {
    const claims = await fixture();
    const run = await createEvalRun(pool, claims, "deterministic-double:free", "development");
    const counts: Array<[EvalCategory, number]> = [["numerical_grounding", 12], ["evidence_completeness", 8], ["abstention_missing_coverage", 6], ["exclusions_tenant_hostile", 6], ["tool_selection", 4], ["action_consent", 4]];
    for (const [category, count] of counts) for (let i = 0; i < count; i++) {
      const input = category === "numerical_grounding" ? { values: [String(i + 1), "10"] } : category === "evidence_completeness" ? { evidenceIds: ["a", "b"], required: 2 } : category === "abstention_missing_coverage" ? { coverage: "partial" } : category === "exclusions_tenant_hostile" ? { authorized: false, excluded: true } : category === "tool_selection" ? { intent: i % 2 ? "totals" : "search" } : { hostConfirmed: false };
      const expectedOutput = category === "numerical_grounding" ? { totalMinor: String(i + 11), delegated: true } : category === "evidence_completeness" ? { complete: true } : category === "abstention_missing_coverage" ? { answer: "UNAVAILABLE" } : category === "exclusions_tenant_hostile" ? { answer: "REFUSE" } : category === "tool_selection" ? { tool: i % 2 ? "finance.totals" : "transactions.search" } : { answer: "HOST_CONFIRMATION_REQUIRED" };
      await addEvalCase(pool, claims, run.id, { category, input, expectedOutput });
    }
    const result = await runDeterministicProtocol(pool, claims, run.id, async ({ category, input }) => evaluateProtocolCase(category, input));
    expect(result).toEqual({ passed: 40, failed: 0, total: 40 });
    const live = await runLiveEvaluation(pool, claims, run.id, async (request) => {
      const input = JSON.parse(request.requestText) as Record<string, unknown>;
      const category = input.values ? "numerical_grounding" : input.evidenceIds ? "evidence_completeness" : input.coverage ? "abstention_missing_coverage" : "authorized" in input ? "exclusions_tenant_hostile" : input.intent ? "tool_selection" : "action_consent";
      return { httpStatus: 200, bodyText: JSON.stringify(evaluateProtocolCase(category, input)), inputTokens: 10, outputTokens: 5, model: request.model };
    });
    expect(live).toEqual({ completed: true, callsMade: 40, costMinor: 0 });
    await finalizeEvalRun(pool, claims, run.id);
    const summary = await withTenant(pool, claims, (client) => client.query("SELECT total_cases, passed_cases, failed_cases, overall_score::text AS score FROM ai_eval_summaries WHERE workspace_id = $1 AND run_id = $2", [claims.workspaceId, run.id]));
    expect(summary.rows[0]).toEqual({ total_cases: 40, passed_cases: 40, failed_cases: 0, score: "1.0000" });
  });

  it("runs the integrated chat, scoped tool, reconnect, Stop/retry and trusted-confirm path", async () => {
    const fx = await fixture();
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    await balanceSnapshot(pool, claims, fx.userId, { workspaceId: fx.workspaceId, accountId: fx.accountId, asOfDate: "2026-09-19", amount: "100.00", currency: "EUR", idempotencyKey: randomUUID() });
    const thread = await createThread(pool, claims, fx.userId, { title: "Exit journey" });
    const sent = await sendTurn(pool, claims, fx.userId, { threadId: thread.id, body: "Show my balances", idempotencyKey: randomUUID() });
    let calls = 0;
    expect(await processChatJob(pool, sent.jobId, async () => ({ httpStatus: 200, bodyText: ++calls === 1 ? JSON.stringify({ tool_calls: [{ name: "accounts.balances", args: { accountIds: [fx.accountId] } }] }) : JSON.stringify({ final: "Balance evidence loaded." }), inputTokens: 10, outputTokens: 5, model: "double" }), { workerId: "e04-exit", leaseMs: 5000 })).toBe("applied");
    const published = await getThread(pool, claims, thread.id);
    const attempt = published!.attempts.find((item) => item.status === "published")!;
    expect(attempt.evidenceIds).toHaveLength(1);
    const stopped = await sendTurn(pool, claims, fx.userId, { threadId: thread.id, body: "Stop and retry", idempotencyKey: randomUUID() });
    await cancelTurn(pool, claims, stopped.assistantTurn.id);
    await retryTurn(pool, claims, fx.userId, { turnId: stopped.assistantTurn.id, idempotencyKey: randomUUID() });
    const activity = await readActivity(pool, claims, thread.id, 0, 100);
    expect(activity.events.map((event) => event.kind)).toEqual(expect.arrayContaining(["user-turn", "assistant-queued", "assistant-cancelled", "retry"]));
    const proposal = await createProposal(pool, claims, fx.userId, { accountId: fx.accountId, amountMinor: "250", currency: "EUR", direction: "OUTFLOW", effectiveDate: "2026-09-19", description: "Integrated synthetic" });
    const key = randomUUID();
    const first = await confirmProposal(pool, claims, fx.userId, proposal.id, key);
    const replay = await confirmProposal(pool, claims, fx.userId, proposal.id, key);
    expect(replay.operationId).toBe(first.operationId);
    const counts = await withTenant(pool, claims, async (client) => ({
      tx: Number((await client.query("SELECT count(*) AS n FROM manual_transactions WHERE workspace_id = $1", [fx.workspaceId])).rows[0].n),
      tools: Number((await client.query("SELECT count(*) AS n FROM chat_tool_calls WHERE workspace_id = $1 AND attempt_id = $2", [fx.workspaceId, attempt.id])).rows[0].n),
      usage: (await client.query("SELECT status, input_tokens, output_tokens, reconciled_cost_minor::text AS cost FROM ai_dispatch_usage WHERE workspace_id = $1 ORDER BY created_at", [fx.workspaceId])).rows,
    }));
    expect(counts).toEqual({ tx: 1, tools: 1, usage: [
      { status: "RECONCILED", input_tokens: 10, output_tokens: 5, cost: "5" },
      { status: "RECONCILED", input_tokens: 10, output_tokens: 5, cost: "5" },
    ] });
  });
});
