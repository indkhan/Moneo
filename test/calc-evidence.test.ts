// E03-S04 calculation evidence: bump calculation version, workspace revision,
// immutable inputs/results hashes, coarse invalidation. Real PostgreSQL.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter } from "../apps/web/src/tenancy.ts";
import { ensureTestPool } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");

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

async function postJson(base: string, path: string, cookie: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function getJson(base: string, path: string, cookie: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  return { status: res.status, json: await res.json() };
}

async function setupWorkspace(base: string, sub: string): Promise<{ cookie: string; workspaceId: string }> {
  const cookie = await login(base, sub);
  const ws = (await postJson(base, "/api/workspaces", cookie, { name: "W", baseCurrency: "EUR" })).json as { id: string };
  return { cookie, workspaceId: ws.id };
}

beforeAll(async () => {
  pool = await ensureTestPool("E03-S04", "moneo_e03_calc_evidence_v1", [
    "workspace_data_revision",
    "calculation_versions",
    "command_operations",
    "ai_dispatch_permits",
    "ai_exclusions",
    "ai_policies",
    "accounts",
    "workspace_members",
    "workspaces",
    "users",
    "app_sessions",
  ]);
  stub = await startStubIssuer();
}, 60_000);

afterAll(async () => {
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e03-s04 calculation evidence and workspace revision", () => {
  it("bumps calculation version and returns new version with hashes", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e04-calc-a");
    const key = randomUUID();
    const bumped = await postJson(base, "/api/commands/calculations.bump_version", cookie, {
      workspaceId,
      idempotencyKey: key,
    });
    expect(bumped.status).toBe(200);
    expect(bumped.json).toMatchObject({
      workspaceId,
      version: "1",
      inputsHash: "pending",
      resultsHash: "pending",
      replayed: false,
    });
    expect(typeof (bumped.json as { operationId: string }).operationId).toBe("string");
    expect(typeof (bumped.json as { createdAt: string }).createdAt).toBe("string");
    // Replay returns identical result
    const replay = await postJson(base, "/api/commands/calculations.bump_version", cookie, {
      workspaceId,
      idempotencyKey: key,
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ replayed: true });
    expect((replay.json as { operationId: string }).operationId).toBe((bumped.json as { operationId: string }).operationId);
  });

  it("returns current calculation version via GET", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e04-calc-b");
    // First bump to create version
    await postJson(base, "/api/commands/calculations.bump_version", cookie, {
      workspaceId,
      idempotencyKey: randomUUID(),
    });
    // Read version
    const version = await getJson(base, `/api/calculations/version?workspaceId=${workspaceId}`, cookie);
    expect(version.status).toBe(200);
    expect(version.json).toMatchObject({
      workspaceId,
      version: "1",
      inputsHash: "pending",
      resultsHash: "pending",
    });
    expect(typeof (version.json as { createdAt: string }).createdAt).toBe("string");
  });

  it("bumps workspace revision independently", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e04-calc-c");
    const key = randomUUID();
    const bumped = await postJson(base, "/api/commands/workspace.bump_revision", cookie, {
      workspaceId,
      idempotencyKey: key,
    });
    expect(bumped.status).toBe(200);
    expect(bumped.json).toMatchObject({
      workspaceId,
      revision: "1",
      replayed: false,
    });
    expect(typeof (bumped.json as { operationId: string }).operationId).toBe("string");
    expect(typeof (bumped.json as { updatedAt: string }).updatedAt).toBe("string");
    // Replay
    const replay = await postJson(base, "/api/commands/workspace.bump_revision", cookie, {
      workspaceId,
      idempotencyKey: key,
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ replayed: true });
    expect((replay.json as { operationId: string }).operationId).toBe((bumped.json as { operationId: string }).operationId);
  });

  it("returns current workspace revision via GET", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e04-calc-d");
    // First bump to create revision
    await postJson(base, "/api/commands/workspace.bump_revision", cookie, {
      workspaceId,
      idempotencyKey: randomUUID(),
    });
    // Read revision
    const revision = await getJson(base, `/api/workspace/revision?workspaceId=${workspaceId}`, cookie);
    expect(revision.status).toBe(200);
    expect(revision.json).toMatchObject({
      workspaceId,
      revision: "1",
    });
    expect(typeof (revision.json as { updatedAt: string }).updatedAt).toBe("string");
  });

  it("enforces tenant isolation for calculation version endpoints", async () => {
    const base = await startApp();
    const { cookie: cookieA, workspaceId: wsA } = await setupWorkspace(base, "e04-tenant-a");
    const { cookie: cookieB, workspaceId: wsB } = await setupWorkspace(base, "e04-tenant-b");

    // User A bumps calculation version
    await postJson(base, "/api/commands/calculations.bump_version", cookieA, {
      workspaceId: wsA,
      idempotencyKey: randomUUID(),
    });

    // User B cannot read A's calculation version
    const readA = await getJson(base, `/api/calculations/version?workspaceId=${wsA}`, cookieB);
    expect(readA.status).toBe(404);
    expect(readA.json).toEqual({ error: "not_found" });

    // User B cannot read A's workspace revision
    await postJson(base, "/api/commands/workspace.bump_revision", cookieA, {
      workspaceId: wsA,
      idempotencyKey: randomUUID(),
    });
    const readRev = await getJson(base, `/api/workspace/revision?workspaceId=${wsA}`, cookieB);
    expect(readRev.status).toBe(404);
  });

  it("idempotency replay returns same operationId", async () => {
    const base = await startApp();
    const { cookie, workspaceId } = await setupWorkspace(base, "e04-idempotent");
    const key = randomUUID();
    const first = await postJson(base, "/api/commands/calculations.bump_version", cookie, {
      workspaceId,
      idempotencyKey: key,
    });
    expect(first.status).toBe(200);
    const opId1 = (first.json as { operationId: string }).operationId;
    // Replay with same key
    const replay = await postJson(base, "/api/commands/calculations.bump_version", cookie, {
      workspaceId,
      idempotencyKey: key,
    });
    expect(replay.status).toBe(200);
    expect((replay.json as { replayed: boolean }).replayed).toBe(true);
    expect((replay.json as { operationId: string }).operationId).toBe(opId1);
    // Version should still be 1 (no new version created on replay)
    const version = await getJson(base, `/api/calculations/version?workspaceId=${workspaceId}`, cookie);
    expect(version.status).toBe(200);
    expect(version.json).toMatchObject({ version: "1" });
  });
});
