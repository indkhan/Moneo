// E04-S03 scoped tools, evidence and dispatch revalidation: the allowlisted
// server tools return bounded decimal-string results identical to the shared
// queries, malformed/oversized/unknown calls fail typed without execution,
// prompt text cannot widen capabilities, and policy/exclusion/revision drift
// blocks stale calls and publication while dispatched cost stays accounted.
// Real PostgreSQL (own `moneo_e04_tools` DB, fails closed); deterministic
// scripted transports only — no live provider.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter, withTenant } from "../apps/web/src/tenancy.ts";
import { setAccountExclusion } from "../apps/web/src/ai-policy.ts";
import { balanceSnapshot, createAccount, listBalanceSnapshots, manualTransaction } from "../apps/web/src/commands/accounts.ts";
import { bumpWorkspaceRevision } from "../apps/web/src/calculations/evidence.ts";
import { getTransactionEvidence, listTransactions } from "../apps/web/src/transactions-query.ts";
import { getFinancialSummary } from "../apps/web/src/calculations/financial-summary.ts";
import {
  buildChatPrompt,
  createToolContext,
  executeTool,
  parseModelOutput,
  revalidateContext,
  ToolError,
} from "../apps/web/src/ai-tools.ts";
import type { DispatchTransport } from "../apps/web/src/ai-dispatch.ts";
import { claimChatGeneration, createThread, getThread, processChatJob, publishTurnFenced, sendTurn } from "../apps/web/src/chat.ts";
import { ensureTestPool } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
const tag = randomBytes(4).toString("hex");

async function startApp(): Promise<string> {
  const config: AuthConfig = {
    issuer: stub.base,
    clientId: STUB_CLIENT_ID,
    clientSecret: STUB_CLIENT_SECRET,
    appBaseUrl: "http://127.0.0.1:1",
    sessionSecret,
    sessionTtlSec: 43200,
  };
  const server = createApp(
    createAuthRouter(config, pool),
    createTenancyRouter(pool, (req) => requestSession(pool, sessionSecret, req)),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  appServers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.appBaseUrl = base;
  return base;
}

async function login(base: string, loginAs: string): Promise<string> {
  const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const authorizeUrl = `${start.headers.get("location")!}&login_as=${loginAs}`;
  const callbackUrl = (await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!;
  const done = await fetch(callbackUrl, { redirect: "manual" });
  return done.headers.get("set-cookie")!.split(";")[0];
}

type Fixture = { cookie: string; userId: string; workspaceId: string; acctA: string; acctB: string; acctC: string };

async function setupFixture(base: string, sub: string, suffix: string): Promise<Fixture> {
  const cookie = await login(base, sub);
  const headers = { cookie, "Content-Type": "application/json" };
  const ws = (await (await fetch(`${base}/api/workspaces`, { method: "POST", headers, body: JSON.stringify({ name: `W-${suffix}`, baseCurrency: "EUR" }) })).json()) as { id: string };
  const workspaceId = ws.id;
  const mk = async (name: string): Promise<string> =>
    ((await (await fetch(`${base}/api/accounts`, { method: "POST", headers, body: JSON.stringify({ workspaceId, name }) })).json()) as { id: string }).id;
  // Accounts are EUR by default? Create explicitly requires currency? The
  // accounts endpoint from S01 takes name only (currency arrives S03?). Check:
  // E03-S01 extended the row with currency. Use the command instead if needed.
  const acctA = await mk(`TOOLS-A-${tag}-${suffix}`);
  const acctB = await mk(`TOOLS-B-${tag}-${suffix}`);
  const acctC = await mk(`TOOLS-C-${tag}-${suffix}`);
  const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub])).rows[0] as { id: string }).id;
  return { cookie, userId, workspaceId, acctA, acctB, acctC };
}

async function scoped<T>(userId: string, workspaceId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenant(pool, { userId, workspaceId }, work);
}

const okTransport = (texts: string[], calls: { count: number }): DispatchTransport => async () => {
  calls.count += 1;
  return { httpStatus: 200, bodyText: texts[Math.min(calls.count - 1, texts.length - 1)]!, inputTokens: 50, outputTokens: 25, model: "double" };
};

beforeAll(async () => {
  process.env["APP_ENV"] = "test";
  pool = await ensureTestPool("E04-S03", "moneo_e04_tools", ["chat_tool_calls", "chat_activity", "chat_attempts", "chat_turns", "chat_threads", "ai_dispatch_usage", "ai_dispatch_reservations", "ai_dispatch_budgets", "manual_transactions", "balance_snapshots", "balance_audit", "mapping_provider_usage", "mapping_provider_reservations", "mapping_proposals", "mapping_profiles", "review_decisions", "source_links", "transactions", "import_commit_batches", "parsed_observations", "source_objects", "imports", "data_sources", "background_job_attempts", "job_dispatch_index", "outbox_events", "background_job_results", "background_jobs", "ai_dispatch_permits", "ai_exclusions", "ai_policies", "command_operations", "accounts", "workspace_members", "workspaces", "users", "app_sessions"]);
  stub = await startStubIssuer();
}, 60_000);

afterAll(async () => {
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

async function seedMoney(fx: Fixture): Promise<void> {
  const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
  const tx = async (accountId: string, amount: string, direction: "INFLOW" | "OUTFLOW", description: string, date: string) =>
    manualTransaction(pool, claims, fx.userId, { workspaceId: fx.workspaceId, accountId, amount, currency: "EUR", direction, effectiveDate: date, description, idempotencyKey: randomUUID() });
  await tx(fx.acctA, "1000.00", "INFLOW", "salary", "2024-02-01");
  await tx(fx.acctA, "50.00", "OUTFLOW", "groceries", "2024-02-05");
  await tx(fx.acctA, "25.50", "OUTFLOW", "groceries", "2024-02-06");
  await tx(fx.acctB, "200.00", "INFLOW", "gift", "2024-02-03");
  const snap = async (accountId: string, asOfDate: string, amount: string) =>
    balanceSnapshot(pool, claims, fx.userId, { workspaceId: fx.workspaceId, accountId, asOfDate, amount, currency: "EUR", idempotencyKey: randomUUID() });
  await snap(fx.acctA, "2024-01-01", "800.00");
  await snap(fx.acctA, "2024-02-01", "900.00");
  await snap(fx.acctB, "2024-02-01", "200.00");
}

/** A real claimed attempt: tool records FK to chat_attempts, so direct
 * executeTool tests claim a generation first (same path the worker uses). */
async function newAttempt(fx: Fixture, suffix: string): Promise<string> {
  const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
  const thread = await createThread(pool, claims, fx.userId, { title: suffix });
  const sent = await sendTurn(pool, claims, fx.userId, { threadId: thread.id, body: `probe ${suffix}`, idempotencyKey: randomUUID() });
  const claimed = await claimChatGeneration(pool, sent.jobId, { workerId: "tools-test", leaseMs: 30_000 });
  if (!claimed) throw new Error("probe claim failed");
  return claimed.attemptId;
}

async function toolCallsFor(attemptId: string, fx: Fixture): Promise<{ status: string; tool_name: string; error_code: string | null }[]> {
  return scoped(fx.userId, fx.workspaceId, async (client) => {
    const r = await client.query("SELECT status, tool_name, error_code FROM chat_tool_calls WHERE workspace_id = $1 AND attempt_id = $2 ORDER BY step", [
      fx.workspaceId,
      attemptId,
    ]);
    return r.rows as { status: string; tool_name: string; error_code: string | null }[];
  });
}

describe("e04-s03 scoped tools and evidence", () => {
  it("search returns bounded decimal-string rows identical to the shared query", async () => {
    const base = await startApp();
    const fx = await setupFixture(base, `synthetic-tools-search-${tag}`, "search");
    await seedMoney(fx);
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    const ctx = await createToolContext(pool, claims);
    const args = { accountIds: [fx.acctA], kind: "all", limit: 50 };
    const out = await executeTool(pool, ctx, await newAttempt(fx, "search"), 1, { name: "transactions.search", args });
    const direct = await listTransactions(pool, claims, { workspaceId: fx.workspaceId, kind: "all", accountId: fx.acctA, limit: 50 });
    expect(out.result).toEqual({ items: direct.items, totals: direct.totals });
    expect(out.resultRows).toBe(3);
    const totals = (out.result as { totals: { count: string; byCurrency: { currency: string; inflowMinor: string; outflowMinor: string }[] } }).totals;
    expect(totals).toMatchObject({ count: "3" });
    expect(totals.byCurrency).toEqual([{ currency: "EUR", count: "3", inflowMinor: "100000", outflowMinor: "7550" }]);
    // Independent oracle: exact SQL sums over the booked rows.
    const sums = await scoped(fx.userId, fx.workspaceId, async (client) => {
      const r = await client.query("SELECT count(*)::int AS n, COALESCE(SUM(CASE WHEN direction='INFLOW' THEN amount_minor ELSE 0 END),0) AS i, COALESCE(SUM(CASE WHEN direction='OUTFLOW' THEN amount_minor ELSE 0 END),0) AS o FROM manual_transactions WHERE workspace_id=$1 AND account_id=$2", [
        fx.workspaceId,
        fx.acctA,
      ]);
      return r.rows[0] as { n: number; i: string; o: string };
    });
    expect(sums).toMatchObject({ n: 3, i: "100000", o: "7550" });
    expect(out.evidence.map((e) => e.kind)).toEqual(["transaction", "transaction", "transaction"]);
  });

  it("multi-account pages keep shared sort/limit/offset semantics exactly", async () => {
    const base = await startApp();
    const fx = await setupFixture(base, `synthetic-tools-page-${tag}`, "page");
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    // Interleaved dates across A/B: a per-account concatenation would order
    // A,A,B,B; shared semantics order globally by date desc, id desc.
    const tx = async (accountId: string, amount: string, direction: "INFLOW" | "OUTFLOW", date: string) =>
      manualTransaction(pool, claims, fx.userId, { workspaceId: fx.workspaceId, accountId, amount, currency: "EUR", direction, effectiveDate: date, description: `page ${date}`, idempotencyKey: randomUUID() });
    await tx(fx.acctA, "10.00", "INFLOW", "2024-02-01");
    await tx(fx.acctA, "10.00", "OUTFLOW", "2024-02-10");
    await tx(fx.acctB, "10.00", "OUTFLOW", "2024-02-05");
    await tx(fx.acctB, "10.00", "INFLOW", "2024-02-15");
    const ctx = await createToolContext(pool, claims);
    const attempt = await newAttempt(fx, "page");
    const page = (await executeTool(pool, ctx, attempt, 1, { name: "transactions.search", args: { accountIds: [fx.acctA, fx.acctB], sort: "date_desc", limit: 2, offset: 1 } })).result as {
      items: { effectiveDate: string; accountId: string }[];
      totals: { count: string; byCurrency: { currency: string; inflowMinor: string; outflowMinor: string }[] };
    };
    expect(page.items.map((i) => [i.effectiveDate, i.accountId])).toEqual([["2024-02-10", fx.acctA], ["2024-02-05", fx.acctB]]);
    expect(page.totals).toMatchObject({ count: "4" });
    expect(page.totals.byCurrency).toEqual([{ currency: "EUR", count: "4", inflowMinor: "2000", outflowMinor: "2000" }]);
    // Unfiltered search defaults to the eligible set (never excluded rows).
    await setAccountExclusion(pool, claims, fx.userId, fx.acctB, true, "synthetic");
    const ctx2 = await createToolContext(pool, claims);
    const attempt2 = await newAttempt(fx, "page2");
    const all = (await executeTool(pool, ctx2, attempt2, 1, { name: "transactions.search", args: { limit: 50 } })).result as {
      items: { accountId: string }[];
      totals: { count: string };
    };
    expect(all.items.every((i) => i.accountId !== fx.acctB)).toBe(true);
    expect(all.totals.count).toBe("2");
  });

  it("partial FX coverage stays partial, never unavailable or zero", async () => {
    const base = await startApp();
    const fx = await setupFixture(base, `synthetic-tools-fx-${tag}`, "fxgap");
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    const kwd = await createAccount(pool, claims, fx.userId, { workspaceId: fx.workspaceId, name: "kwd", currency: "KWD", idempotencyKey: randomUUID() });
    await manualTransaction(pool, claims, fx.userId, { workspaceId: fx.workspaceId, accountId: kwd.view.id, amount: "5.000", currency: "KWD", direction: "INFLOW", effectiveDate: "2024-02-01", description: "kwd", idempotencyKey: randomUUID() });
    await manualTransaction(pool, claims, fx.userId, { workspaceId: fx.workspaceId, accountId: fx.acctA, amount: "100.00", currency: "EUR", direction: "INFLOW", effectiveDate: "2024-02-01", description: "eur", idempotencyKey: randomUUID() });
    const ctx = await createToolContext(pool, claims);
    const totals = (await executeTool(pool, ctx, await newAttempt(fx, "fxgap"), 1, { name: "finance.totals", args: { accountIds: [fx.acctA, kwd.view.id] } })).result as {
      coverage: string;
      incomeMinor: string;
      unvaluedCount: string;
      perAccount: { accountId: string; coverage: string }[];
    };
    const byId = new Map(totals.perAccount.map((p) => [p.accountId, p]));
    expect(byId.get(kwd.view.id)?.coverage).toBe("unavailable");
    expect(totals.coverage).toBe("partial");
    expect(totals.incomeMinor).toBe("10000");
    expect(totals.unvaluedCount).toBe("1");
  });

  it("evidence, balances and totals match their shared reads exactly", async () => {
    const base = await startApp();
    const fx = await setupFixture(base, `synthetic-tools-reads-${tag}`, "reads");
    await seedMoney(fx);
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    const ctx = await createToolContext(pool, claims);
    const attempt = await newAttempt(fx, "reads");
    const search = (await executeTool(pool, ctx, attempt, 1, { name: "transactions.search", args: { accountIds: [fx.acctA], kind: "manual", limit: 1 } })).result as {
      items: { id: string }[];
    };
    const txId = search.items[0]!.id;
    const ev = await executeTool(pool, ctx, attempt, 2, { name: "transactions.evidence", args: { transactionId: txId, kind: "manual" } });
    expect(ev.result).toEqual({ evidence: await getTransactionEvidence(pool, claims, "manual", txId) });
    const bal = (await executeTool(pool, ctx, attempt, 3, { name: "accounts.balances", args: { accountIds: [fx.acctA, fx.acctC], asOfDate: "2024-03-01" } })).result as {
      balances: { accountId: string; snapshot: { amountMinor: string; asOfDate: string } | null; unavailable: boolean }[];
    };
    const directA = await listBalanceSnapshots(pool, claims, fx.acctA, 100, 0);
    const byId = new Map(bal.balances.map((b) => [b.accountId, b]));
    expect(byId.get(fx.acctA)).toMatchObject({ accountId: fx.acctA, unavailable: false });
    expect(byId.get(fx.acctA)!.snapshot).toEqual(directA.find((s) => s.asOfDate <= "2024-03-01") ?? null);
    expect(byId.get(fx.acctC)).toMatchObject({ accountId: fx.acctC, snapshot: null, unavailable: true });
    // Cutoff honesty: a later snapshot never leaks into a historical read.
    const cut = (await executeTool(pool, ctx, attempt, 4, { name: "accounts.balances", args: { accountIds: [fx.acctA], asOfDate: "2024-01-15" } })).result as {
      balances: { snapshot: { amountMinor: string } | null }[];
    };
    expect(cut.balances[0]!.snapshot?.amountMinor).toBe("80000");
    const totals = (await executeTool(pool, ctx, attempt, 5, { name: "finance.totals", args: { accountIds: [fx.acctA, fx.acctB] } })).result as {
      baseCurrency: string;
      incomeMinor: string;
      spendMinor: string;
      cashMinor: string;
      coverage: string;
      unvaluedCount: string;
      perAccount: { accountId: string; incomeMinor: string; spendMinor: string }[];
    };
    expect(totals).toMatchObject({ baseCurrency: "EUR", incomeMinor: "120000", spendMinor: "7550", cashMinor: "112450", coverage: "full", unvaluedCount: "0" });
    const perId = new Map(totals.perAccount.map((p) => [p.accountId, p]));
    expect(perId.get(fx.acctA)).toMatchObject({ incomeMinor: "100000", spendMinor: "7550" });
    expect(perId.get(fx.acctB)).toMatchObject({ incomeMinor: "20000", spendMinor: "0" });
    const direct = await getFinancialSummary(pool, claims, fx.workspaceId, { accountId: fx.acctA });
    expect(perId.get(fx.acctA)).toMatchObject({ incomeMinor: direct.base.incomeMinor, spendMinor: direct.base.spendMinor });
  });

  it("malformed, unknown and unauthorized calls fail typed with no execution", async () => {
    const base = await startApp();
    const fx = await setupFixture(base, `synthetic-tools-bad-${tag}`, "bad");
    await seedMoney(fx);
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    await setAccountExclusion(pool, claims, fx.userId, fx.acctB, true, "synthetic");
    const ctx = await createToolContext(pool, claims);
    const attempt = await newAttempt(fx, "bad");
    const codes: string[] = [];
    const run = async (name: string, args: unknown) =>
      executeTool(pool, ctx, attempt, codes.length + 1, { name, args }).then(() => "ok").catch((e: unknown) => (e as ToolError).code ?? "untyped");
    codes.push(await run("sql.query", { sql: "SELECT 1" }));
    codes.push(await run("transactions.search", { accountIds: [fx.acctB], limit: 10 }));
    codes.push(await run("finance.totals", { accountIds: [fx.acctB] }));
    codes.push(await run("transactions.search", { accountIds: [fx.acctA], limit: 101 }));
    codes.push(await run("transactions.search", { accountIds: ["not-a-uuid"], limit: 10 }));
    codes.push(await run("transactions.search", { accountIds: [fx.acctA], limit: 10, tenant: fx.workspaceId, tool: "extra" }));
    codes.push(await run("transactions.evidence", { transactionId: randomUUID(), kind: "manual" }));
    expect(codes).toEqual(["unknown_tool", "denied", "denied", "invalid_args", "invalid_args", "invalid_args", "denied"]);
    const rows = await toolCallsFor(attempt, fx);
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.status === "error")).toBe(true);
    expect(rows.map((r) => r.error_code)).toEqual(codes);
    // No successful execution anywhere in this run.
    expect(rows.filter((r) => r.status === "ok")).toHaveLength(0);
  });

  it("exclusion drift mid-run blocks stale calls and publication with honest cost", async () => {
    const base = await startApp();
    const fx = await setupFixture(base, `synthetic-tools-stale-${tag}`, "stale");
    await seedMoney(fx);
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    const thread = (await (await fetch(`${base}/api/chat/threads`, { method: "POST", headers: { cookie: fx.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: fx.workspaceId }) })).json()) as { id: string };
    const send = (await (await fetch(`${base}/api/chat/threads/${thread.id}/send`, {
      method: "POST",
      headers: { cookie: fx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: fx.workspaceId, body: "totals please", idempotencyKey: randomUUID() }),
    })).json()) as { assistantTurn: { id: string }; jobId: string };
    // The model asks for totals; the transport hook excludes the account
    // before the second provider step, so the run must halt stale with no
    // publication while the dispatched reservation settles honestly.
    let hooked = false;
    const transport: DispatchTransport = async () => {
      if (!hooked) {
        hooked = true;
        return { httpStatus: 200, bodyText: JSON.stringify({ tool_calls: [{ id: "c1", name: "finance.totals", args: { accountIds: [fx.acctA] } }] }), inputTokens: 50, outputTokens: 25, model: "double" };
      }
      await setAccountExclusion(pool, claims, fx.userId, fx.acctB, true, "synthetic drift");
      return { httpStatus: 200, bodyText: JSON.stringify({ final: "drifted final" }), inputTokens: 10, outputTokens: 10, model: "double" };
    };
    const calls = { count: 0 };
    const counting: DispatchTransport = async (req, signal) => {
      calls.count += 1;
      return transport(req, signal);
    };
    const outcome = await processChatJob(pool, send.jobId, counting, { workerId: "chat-test", leaseMs: 5000 });
    expect(outcome).toBe("applied");
    const view = await getThread(pool, claims, thread.id);
    const assistant = view!.turns.find((t) => t.id === send.assistantTurn.id)!;
    // Publication blocked: the drifted final never lands on the turn.
    expect(assistant.status).toBe("interrupted");
    expect(assistant.body).toBe("");
    expect(calls.count).toBeGreaterThanOrEqual(1);
    // Already-dispatched cost is honestly settled, never leaked RESERVED.
    const states = await scoped(fx.userId, fx.workspaceId, async (client) => {
      const r = await client.query("SELECT status FROM ai_dispatch_reservations WHERE workspace_id = $1", [fx.workspaceId]);
      return (r.rows as { status: string }[]).map((row) => row.status);
    });
    expect(states.includes("RESERVED")).toBe(false);
    expect(states.length).toBeGreaterThanOrEqual(1);
  });

  it("revision drift blocks a direct tool call without execution", async () => {
    const base = await startApp();
    const fx = await setupFixture(base, `synthetic-tools-rev-${tag}`, "rev");
    await seedMoney(fx);
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    const ctx = await createToolContext(pool, claims);
    const attempt = await newAttempt(fx, "rev");
    await bumpWorkspaceRevision(pool, claims, fx.userId, { workspaceId: fx.workspaceId, idempotencyKey: randomUUID() });
    const code = await executeTool(pool, ctx, attempt, 1, { name: "transactions.search", args: { accountIds: [fx.acctA], limit: 5 } })
      .then(() => "ok")
      .catch((e: unknown) => (e as ToolError).code ?? "untyped");
    expect(code).toBe("stale");
    await expect(revalidateContext(pool, ctx)).rejects.toThrow();
  });

  it("unsupported questions abstain verbatim; denials never fabricate totals", async () => {
    const base = await startApp();
    const fx = await setupFixture(base, `synthetic-tools-abs-${tag}`, "abs");
    await seedMoney(fx);
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    await setAccountExclusion(pool, claims, fx.userId, fx.acctA, true, "synthetic");
    await setAccountExclusion(pool, claims, fx.userId, fx.acctB, true, "synthetic");
    const ctx = await createToolContext(pool, claims);
    expect(ctx.eligibleAccountIds).toEqual([fx.acctC].sort());
    const code = await executeTool(pool, ctx, await newAttempt(fx, "abs"), 1, { name: "finance.totals", args: { accountIds: [fx.acctA] } })
      .then(() => "ok")
      .catch((e: unknown) => (e as ToolError).code ?? "untyped");
    expect(code).toBe("denied");
    // The model abstains; the abstention publishes verbatim with zero tools.
    const thread = (await (await fetch(`${base}/api/chat/threads`, { method: "POST", headers: { cookie: fx.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: fx.workspaceId }) })).json()) as { id: string };
    const send = (await (await fetch(`${base}/api/chat/threads/${thread.id}/send`, {
      method: "POST",
      headers: { cookie: fx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: fx.workspaceId, body: "how much?", idempotencyKey: randomUUID() }),
    })).json()) as { assistantTurn: { id: string }; jobId: string };
    const calls = { count: 0 };
    const outcome = await processChatJob(pool, send.jobId, okTransport(["I cannot answer from available evidence."], calls), { workerId: "chat-test", leaseMs: 5000 });
    expect(outcome).toBe("applied");
    const view = await getThread(pool, claims, thread.id);
    expect(view!.turns.find((t) => t.id === send.assistantTurn.id)).toMatchObject({ status: "completed", body: "I cannot answer from available evidence." });
  });

  it("tool-call and step caps halt the run without publication", async () => {
    const base = await startApp();
    const fx = await setupFixture(base, `synthetic-tools-cap-${tag}`, "cap");
    await seedMoney(fx);
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    const thread = (await (await fetch(`${base}/api/chat/threads`, { method: "POST", headers: { cookie: fx.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: fx.workspaceId }) })).json()) as { id: string };
    const send = (await (await fetch(`${base}/api/chat/threads/${thread.id}/send`, {
      method: "POST",
      headers: { cookie: fx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: fx.workspaceId, body: "loop me", idempotencyKey: randomUUID() }),
    })).json()) as { assistantTurn: { id: string }; jobId: string };
    const greedy = JSON.stringify({ tool_calls: Array.from({ length: 9 }, (_, i) => ({ id: `g${i}`, name: "transactions.search", args: { accountIds: [fx.acctA], limit: 1 } })) });
    const calls = { count: 0 };
    const outcome = await processChatJob(pool, send.jobId, okTransport([greedy], calls), { workerId: "chat-test", leaseMs: 5000 });
    expect(outcome).toBe("applied");
    const view = await getThread(pool, claims, thread.id);
    // Nine calls in one message exceed the per-run cap: no publication, no
    // tool executed for the greedy step.
    expect(view!.turns.find((t) => t.id === send.assistantTurn.id)?.status).toBe("interrupted");
    const rows = await scoped(fx.userId, fx.workspaceId, async (client) => {
      const r = await client.query("SELECT count(*)::int AS n FROM chat_tool_calls WHERE workspace_id = $1", [fx.workspaceId]);
      return (r.rows[0] as { n: number }).n;
    });
    expect(rows).toBe(0);
  });

  it("foreign contexts are denied and unscoped tool rows read zero", async () => {
    const base = await startApp();
    const a = await setupFixture(base, `synthetic-tools-fa-${tag}`, "fa");
    const b = await setupFixture(base, `synthetic-tools-fb-${tag}`, "fb");
    await seedMoney(b);
    const claimsB = { userId: b.userId, workspaceId: b.workspaceId };
    const ctxB = await createToolContext(pool, claimsB);
    await expect(createToolContext(pool, { userId: a.userId, workspaceId: b.workspaceId })).rejects.toThrow();
    // Cross-workspace context confusion (A's identity on B's context) is
    // denied at revalidation before any tool runs; the error record itself
    // fails closed with the same denial.
    const mixed = await executeTool(pool, { ...ctxB, claims: { userId: a.userId, workspaceId: b.workspaceId } }, randomUUID(), 1, {
      name: "transactions.search",
      args: { accountIds: [b.acctA], limit: 5 },
    })
      .then(() => "ok")
      .catch((e: unknown) => (e as Error).constructor.name);
    expect(mixed).toBe("TenantDenied");
    const unscoped = await pool.query("SELECT count(*)::int AS n FROM chat_tool_calls");
    expect((unscoped.rows[0] as { n: number }).n).toBe(0);
  });

  it("stale policy between final gate and publish aborts without landing text", async () => {
    const base = await startApp();
    const fx = await setupFixture(base, `synthetic-tools-pub-${tag}`, "pub");
    await seedMoney(fx);
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    const ctx = await createToolContext(pool, claims);
    const thread = await createThread(pool, claims, fx.userId, { title: "pub" });
    const sent = await sendTurn(pool, claims, fx.userId, { threadId: thread.id, body: "race", idempotencyKey: randomUUID() });
    const claimed = (await claimChatGeneration(pool, sent.jobId, { workerId: "tools-test", leaseMs: 30_000 }))!;
    await setAccountExclusion(pool, claims, fx.userId, fx.acctB, true, "synthetic race");
    const gated = await publishTurnFenced(pool, claimed.full, { attemptId: claimed.claim.attemptId, generation: claimed.claim.generation }, sent.assistantTurn.id, claimed.attemptId, "stale text", {
      policyVersion: ctx.policyVersion,
      revision: ctx.revision,
    });
    expect(gated).toEqual({ ok: false, stale: true });
    const view = await getThread(pool, claims, thread.id);
    // Untouched: still running, empty body, no published event.
    expect(view!.turns.find((t) => t.id === sent.assistantTurn.id)).toMatchObject({ status: "running", body: "" });
    const activity = await scoped(fx.userId, fx.workspaceId, async (client) => {
      const r = await client.query("SELECT kind FROM chat_activity WHERE workspace_id = $1 AND thread_id = $2 ORDER BY seq", [fx.workspaceId, thread.id]);
      return (r.rows as { kind: string }[]).map((row) => row.kind);
    });
    expect(activity).not.toContain("assistant-published");
  });

  it("production routes only when qualified, never by fallback", async () => {
    const base = await startApp();
    const fx = await setupFixture(base, `synthetic-tools-route-${tag}`, "route");
    await seedMoney(fx);
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    const runOnce = async (): Promise<{ status: string; routes: string[] }> => {
      const thread = (await (await fetch(`${base}/api/chat/threads`, { method: "POST", headers: { cookie: fx.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: fx.workspaceId }) })).json()) as { id: string };
      const send = (await (await fetch(`${base}/api/chat/threads/${thread.id}/send`, {
        method: "POST",
        headers: { cookie: fx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: fx.workspaceId, body: "route?", idempotencyKey: randomUUID() }),
      })).json()) as { assistantTurn: { id: string }; jobId: string };
      const outcome = await processChatJob(pool, send.jobId, okTransport(["routed answer"], { count: 0 }), { workerId: "chat-test", leaseMs: 5000 });
      const routes = await scoped(fx.userId, fx.workspaceId, async (client) => {
        const r = await client.query("SELECT DISTINCT route AS route FROM ai_dispatch_reservations WHERE workspace_id = $1", [fx.workspaceId]);
        return (r.rows as { route: string }[]).map((row) => row.route).sort();
      });
      return { status: outcome, routes };
    };
    const dev = await runOnce();
    expect(dev.status).toBe("applied");
    expect(dev.routes).toEqual(["development"]);
    const saved = process.env["AI_PRODUCTION_QUALIFIED"];
    process.env["AI_PRODUCTION_QUALIFIED"] = "1";
    try {
      const prod = await runOnce();
      expect(prod.status).toBe("applied");
      expect(prod.routes).toEqual(["development", "production"]);
    } finally {
      if (saved === undefined) delete process.env["AI_PRODUCTION_QUALIFIED"];
      else process.env["AI_PRODUCTION_QUALIFIED"] = saved;
    }
  });

  it("a tool-using generation publishes evidence-backed text with honest usage", async () => {
    const base = await startApp();
    const fx = await setupFixture(base, `synthetic-tools-e2e-${tag}`, "e2e");
    await seedMoney(fx);
    const claims = { userId: fx.userId, workspaceId: fx.workspaceId };
    const thread = (await (await fetch(`${base}/api/chat/threads`, { method: "POST", headers: { cookie: fx.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: fx.workspaceId }) })).json()) as { id: string };
    const send = (await (await fetch(`${base}/api/chat/threads/${thread.id}/send`, {
      method: "POST",
      headers: { cookie: fx.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: fx.workspaceId, body: "spending?", idempotencyKey: randomUUID() }),
    })).json()) as { assistantTurn: { id: string }; jobId: string };
    const calls = { count: 0 };
    const outcome = await processChatJob(
      pool,
      send.jobId,
      okTransport(
        [
          JSON.stringify({ tool_calls: [{ id: "t1", name: "finance.totals", args: { accountIds: [fx.acctA, fx.acctB] } }] }),
          JSON.stringify({ final: "You spent 75.50 EUR of 1200.00 EUR income." }),
        ],
        calls,
      ),
      { workerId: "chat-test", leaseMs: 5000 },
    );
    expect(outcome).toBe("applied");
    expect(calls.count).toBe(2);
    const view = await getThread(pool, claims, thread.id);
    expect(view!.turns.find((t) => t.id === send.assistantTurn.id)).toMatchObject({ status: "completed", body: "You spent 75.50 EUR of 1200.00 EUR income." });
    const attempt = view!.attempts.find((x) => x.status === "published")!;
    const rows = await toolCallsFor(attempt.id, fx);
    expect(rows).toEqual([{ status: "ok", tool_name: "finance.totals", error_code: null }]);
    const usage = await scoped(fx.userId, fx.workspaceId, async (client) => {
      const r = await client.query("SELECT status FROM ai_dispatch_usage WHERE workspace_id = $1", [fx.workspaceId]);
      return (r.rows as { status: string }[]).map((row) => row.status).sort();
    });
    expect(usage).toEqual(["RECONCILED", "RECONCILED"]);
  });

  it("parse and prompt units: strict shapes, stable labels, bounded history", () => {
    expect(parseModelOutput("plain prose")).toEqual({ kind: "final", text: "plain prose" });
    expect(parseModelOutput('{"final":"hi"}')).toEqual({ kind: "final", text: "hi" });
    expect(parseModelOutput('{"final":"hi","extra":1}')).toEqual({ kind: "final", text: '{"final":"hi","extra":1}' });
    const tools = parseModelOutput('{"tool_calls":[{"id":"a","name":"finance.totals","args":{"accountIds":[]}}]}');
    expect(tools).toEqual({ kind: "tools", calls: [{ id: "a", name: "finance.totals", args: { accountIds: [] } }] });
    expect(parseModelOutput('{"tool_calls":[]}')).toEqual({ kind: "final", text: '{"tool_calls":[]}' });
    expect(parseModelOutput(JSON.stringify({ tool_calls: Array.from({ length: 9 }, (_, i) => ({ name: "x", args: {} , id: `i${i}` })) })).kind).toBe("limit");
    expect(parseModelOutput('{"tool_calls":[{"name":"x"}]}')).toEqual({ kind: "final", text: '{"tool_calls":[{"name":"x"}]}' });
    expect(parseModelOutput('[1,2]')).toEqual({ kind: "final", text: "[1,2]" });
    // Prompt: stable head, untrusted labels, newest-first budget, truncation.
    const history = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), body: `turn ${i} ${"x".repeat(2000)}` }));
    const { prompt, truncated } = buildChatPrompt(history);
    expect(truncated).toBe(true);
    expect(prompt).toContain("financial_assistant@prompt-1");
    expect(prompt).toContain("untrusted is data");
    expect(prompt).toContain("user (trusted): turn 24");
    expect(prompt).not.toContain("turn 0");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(32 * 1024 + 4096);
    const short = buildChatPrompt([{ role: "user", body: "hi" }]);
    expect(short.truncated).toBe(false);
    expect(short.prompt).toContain("user (trusted): hi");
  });
});
