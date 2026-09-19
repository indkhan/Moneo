import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { chromium } from "playwright";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter } from "../apps/web/src/tenancy.ts";
import { withTenant } from "../apps/web/src/tenancy.ts";
import { createUiRouter } from "../apps/web/src/ui/routes.ts";
import { confirmProposal, createProposal } from "../apps/web/src/ai-action-proposals.ts";
import { ensureTestPool } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const servers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");

async function setup(): Promise<{ base: string; cookie: string; userId: string; workspaceId: string; accountId: string }> {
  const config: AuthConfig = { issuer: stub.base, clientId: STUB_CLIENT_ID, clientSecret: STUB_CLIENT_SECRET, appBaseUrl: "http://127.0.0.1:1", sessionSecret, sessionTtlSec: 43200 };
  const session = (req: Parameters<typeof requestSession>[2]) => requestSession(pool, sessionSecret, req);
  const server = createApp(createAuthRouter(config, pool), createTenancyRouter(pool, session), { ui: createUiRouter(pool, session, config) });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.appBaseUrl = base;
  const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const callback = (await fetch(`${start.headers.get("location")!}&login_as=synthetic-ai-action`, { redirect: "manual" })).headers.get("location")!;
  const cookie = (await fetch(callback, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0];
  const headers = { cookie, "Content-Type": "application/json" };
  const workspace = await (await fetch(`${base}/api/workspaces`, { method: "POST", headers, body: JSON.stringify({ name: "Actions", baseCurrency: "EUR" }) })).json() as { id: string };
  const account = await (await fetch(`${base}/api/accounts`, { method: "POST", headers, body: JSON.stringify({ workspaceId: workspace.id, name: "Checking" }) })).json() as { id: string };
  const userId = (await pool.query("SELECT id FROM users WHERE auth_subject = 'synthetic-ai-action'")).rows[0].id as string;
  return { base, cookie, userId, workspaceId: workspace.id, accountId: account.id };
}

beforeAll(async () => {
  pool = await ensureTestPool("E04-S05", "moneo_e04_action", ["ai_action_proposals", "manual_transactions", "command_operations", "accounts", "workspace_members", "workspaces", "users", "app_sessions"]);
  stub = await startStubIssuer();
}, 60_000);

afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (stub) await stub.close();
  if (pool) await pool.end();
});

describe("e04-s05 trusted action confirmation", () => {
  it("concurrent same-key confirmation converges to one transaction", async () => {
    const { userId, workspaceId, accountId } = await setup();
    const claims = { userId, workspaceId };
    const proposal = await createProposal(pool, claims, userId, { accountId, amountMinor: "1234", currency: "EUR", direction: "OUTFLOW", effectiveDate: "2026-09-19", description: "Synthetic" });
    const key = randomUUID();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => confirmProposal(pool, claims, userId, proposal.id, key)));
    expect(results.map((r) => r.status === "fulfilled" ? "ok" : String(r.reason))).toEqual(["ok", "ok", "ok", "ok"]);
    expect(new Set(results.map((r) => r.status === "fulfilled" ? r.value.operationId : "failed")).size).toBe(1);
    const count = await withTenant(pool, claims, async (client) => Number((await client.query("SELECT count(*) AS n FROM manual_transactions WHERE workspace_id = $1", [workspaceId])).rows[0].n));
    expect(count).toBe(1);
  });

  it("renders and confirms through a trusted host form", async () => {
    const { base, cookie, userId, workspaceId, accountId } = await setup();
    const proposal = await createProposal(pool, { userId, workspaceId }, userId, { accountId, amountMinor: "1234", currency: "EUR", direction: "OUTFLOW", effectiveDate: "2026-09-19", description: "Synthetic" });
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.addCookies([{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: base }]);
      const page = await context.newPage();
      await page.goto(`${base}/w/${workspaceId}/ai-actions/${proposal.id}`);
      expect(await page.getByText("12.34 EUR").isVisible()).toBe(true);
      const confirm = page.getByRole("button", { name: "Confirm transaction" });
      await confirm.focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(new RegExp(`/w/${workspaceId}/transactions\\?notice=ai-confirmed`));
      expect(await page.getByText("recorded in the audit history").isVisible()).toBe(true);
      await page.getByRole("button", { name: "Undo with compensating transaction" }).click();
      await page.waitForURL(new RegExp(`/w/${workspaceId}/transactions\\?notice=undone`));
    } finally {
      await browser.close();
    }
    const rows = await withTenant(pool, { userId, workspaceId }, async (client) => ({
      transactions: Number((await client.query("SELECT count(*) AS n FROM manual_transactions WHERE workspace_id = $1", [workspaceId])).rows[0].n),
      audit: (await client.query("SELECT action, compensating_operation_id IS NOT NULL AS compensated FROM audit_events WHERE workspace_id = $1 ORDER BY created_at", [workspaceId])).rows,
    }));
    expect(rows).toEqual({ transactions: 2, audit: [{ action: "create", compensated: false }, { action: "undo", compensated: true }] });
  }, 15_000);

  it("rejects replay, tampering, expiry, and stale account or policy state", async () => {
    const { userId, workspaceId, accountId } = await setup();
    const claims = { userId, workspaceId };
    const payload = { accountId, amountMinor: "1234", currency: "EUR", direction: "OUTFLOW" as const, effectiveDate: "2026-09-19", description: "Synthetic" };
    const guarded = await createProposal(pool, claims, userId, payload);
    await expect(confirmProposal(pool, claims, randomUUID(), guarded.id, randomUUID())).rejects.toBeInstanceOf(Error);
    const foreignWorkspaceId = (await setup()).workspaceId;
    await expect(confirmProposal(pool, { userId, workspaceId: foreignWorkspaceId }, userId, guarded.id, randomUUID())).rejects.toBeInstanceOf(Error);
    const confirmed = await createProposal(pool, claims, userId, payload);
    await confirmProposal(pool, claims, userId, confirmed.id, randomUUID());
    await expect(confirmProposal(pool, claims, userId, confirmed.id, randomUUID())).rejects.toMatchObject({ code: "already_confirmed" });

    const tampered = await createProposal(pool, claims, userId, payload);
    await withTenant(pool, claims, (client) => client.query("UPDATE ai_action_proposals SET payload = jsonb_set(payload, '{amountMinor}', '\"9999\"') WHERE workspace_id = $1 AND id = $2", [workspaceId, tampered.id]));
    await expect(confirmProposal(pool, claims, userId, tampered.id, randomUUID())).rejects.toMatchObject({ code: "payload_mismatch" });

    const expired = await createProposal(pool, claims, userId, payload);
    await withTenant(pool, claims, (client) => client.query("UPDATE ai_action_proposals SET expires_at = now() - interval '1 second' WHERE workspace_id = $1 AND id = $2", [workspaceId, expired.id]));
    await expect(confirmProposal(pool, claims, userId, expired.id, randomUUID())).rejects.toMatchObject({ code: "expired" });

    const staleAccount = await createProposal(pool, claims, userId, payload);
    await withTenant(pool, claims, (client) => client.query("UPDATE accounts SET version = version + 1 WHERE workspace_id = $1 AND id = $2", [workspaceId, accountId]));
    await expect(confirmProposal(pool, claims, userId, staleAccount.id, randomUUID())).rejects.toMatchObject({ code: "version_mismatch" });

    const stalePolicy = await createProposal(pool, claims, userId, payload);
    await withTenant(pool, claims, (client) => client.query("UPDATE ai_policies SET policy_version = policy_version + 1 WHERE workspace_id = $1", [workspaceId]));
    await expect(confirmProposal(pool, claims, userId, stalePolicy.id, randomUUID())).rejects.toMatchObject({ code: "version_mismatch" });
  });
});
