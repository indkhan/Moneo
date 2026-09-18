// E01-S05 AI data policy gate: exclusions, versioned permits, sentinel
// non-leakage through selection/aggregates/dispatch, invalidation on change
// and unknown-account deny. Real PostgreSQL (own `moneo_e01_policy` DB, fails
// closed without PG); recording fake transport only — no live provider.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter } from "../apps/web/src/tenancy.ts";
import { consumePermit, issuePermit, selectEligible, setAccountExclusion, summarizeEligible } from "../apps/web/src/ai-policy.ts";
import { createFakeProvider } from "../apps/web/src/ai-fake-provider.ts";
import { ensureTestPool } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");
// Unique sentinel names: excluded data must never surface; included data must
// (non-vacuous). Random suffix keeps parallel runs from colliding.
const tag = randomBytes(4).toString("hex");
const SENTINEL_OUT = `SENTINEL-OUT-${tag}-alpha`;
const SENTINEL_IN = `SENTINEL-IN-${tag}-beta`;

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

async function call(method: string, url: string, cookie: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

async function setupWorkspace(base: string, sub: string): Promise<{ cookie: string; workspaceId: string; acctIn: string; acctOut: string }> {
  const cookie = await login(base, sub);
  const ws = (await (await fetch(`${base}/api/workspaces`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "W", baseCurrency: "EUR" }),
  })).json()) as { id: string };
  const mk = async (name: string): Promise<string> =>
    ((await (await fetch(`${base}/api/accounts`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: ws.id, name }),
    })).json()) as { id: string }).id;
  const acctIn = await mk(SENTINEL_IN);
  const acctOut = await mk(SENTINEL_OUT);
  return { cookie, workspaceId: ws.id, acctIn, acctOut };
}

beforeAll(async () => {
  // Pin the test environment name so the test-dispatch allowlist is
  // deterministic regardless of the developer's shell (Windows-safe: no
  // cross-env dependency for inline VAR= assignments).
  process.env["APP_ENV"] = "test";
  // Own database: parallel vitest workers must not share suite state.
  pool = await ensureTestPool("E01-S05", "moneo_e01_policy", ["mapping_provider_usage", "mapping_provider_reservations", "mapping_proposals", "mapping_profiles", "review_decisions", "source_links", "transactions", "import_commit_batches", "parsed_observations", "source_objects", "imports", "data_sources", "background_job_attempts", "job_dispatch_index", "outbox_events", "background_job_results", "background_jobs", "ai_dispatch_permits", "ai_exclusions", "ai_policies", "command_operations", "accounts", "workspace_members", "workspaces", "users", "app_sessions"]);
  stub = await startStubIssuer();
}, 60_000);

afterAll(async () => {
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e01-s05 ai data policy", () => {
  it("excluded sentinels never reach selection, summary, or the fake transport", async () => {
    const base = await startApp();
    const { cookie, workspaceId, acctIn, acctOut } = await setupWorkspace(base, "synthetic-pol-a");
    const excl = await call("PUT", `${base}/api/ai/exclusions`, cookie, { workspaceId, accountId: acctOut, excluded: true, reason: "synthetic test" });
    expect(excl.status).toBe(200);
    expect(excl.json).toMatchObject({ policyVersion: "2", excludedAccountIds: [acctOut] });

    const permit = (await call("POST", `${base}/api/ai/permits`, cookie, { workspaceId, purpose: "synthetic-summary" })).json as { id: string; policyVersion: string; eligibleAccountIds: string[] };
    expect(permit.policyVersion).toBe("2");
    expect(permit.eligibleAccountIds).toEqual([acctIn].sort());

    // Direct selection: included present (non-vacuous), excluded absent.
    const user = (await pool.query("SELECT id FROM users WHERE auth_subject = $1", ["synthetic-pol-a"])).rows[0].id as string;
    const { withTenant } = await import("../apps/web/src/tenancy.ts");
    const claims = { userId: user, workspaceId };
    const selection = await withTenant(pool, claims, async () => selectEligible(pool, claims, permit.id));
    expect(selection.accounts.map((a) => a.name)).toContain(SENTINEL_IN);
    expect(JSON.stringify(selection)).not.toContain(SENTINEL_OUT);
    expect(selection.provenance).toMatchObject({ policyVersion: "2" });

    // Aggregates exclude and declare partial coverage.
    const summary = await withTenant(pool, claims, async () => summarizeEligible(pool, claims));
    expect(summary).toMatchObject({ accountCount: 1, coverage: "partial", policyVersion: "2" });

    // Fake dispatch: tripwire armed with the excluded sentinel passes, and
    // the log stores hashes/ids only — never names.
    const sent = await call("POST", `${base}/api/ai/test-dispatch`, cookie, { workspaceId, permitId: permit.id, sentinels: [SENTINEL_OUT] });
    expect(sent.status).toBe(200);
    const record = (sent.json as { record: Record<string, unknown> }).record;
    expect(record).toMatchObject({ purpose: "test-dispatch", policyVersion: "2" });
    expect(JSON.stringify(record)).not.toContain(SENTINEL_OUT);
    expect(JSON.stringify(record)).not.toContain(SENTINEL_IN);
    const fake = createFakeProvider();
    expect(() => fake.send(selection, "probe", [SENTINEL_OUT])).not.toThrow();
    expect(() => fake.send({ accounts: [{ workspaceId, id: acctOut, name: SENTINEL_OUT }], provenance: selection.provenance }, "probe", [SENTINEL_OUT])).toThrow(/tripwire/);
  });

  it("policy changes invalidate queued permits; consumed history is not recalled", async () => {
    const base = await startApp();
    const { cookie, workspaceId, acctIn, acctOut } = await setupWorkspace(base, "synthetic-pol-b");
    const first = (await call("POST", `${base}/api/ai/permits`, cookie, { workspaceId, purpose: "p1" })).json as { id: string };
    const sent1 = await call("POST", `${base}/api/ai/test-dispatch`, cookie, { workspaceId, permitId: first.id });
    expect(sent1.status).toBe(200); // dispatched history
    const queued = (await call("POST", `${base}/api/ai/permits`, cookie, { workspaceId, purpose: "p2" })).json as { id: string };
    const excl = await call("PUT", `${base}/api/ai/exclusions`, cookie, { workspaceId, accountId: acctOut, excluded: true });
    expect((excl.json as { policyVersion: string }).policyVersion).toBe("2");
    // Queued permit was invalidated by the policy change.
    const stale = await call("POST", `${base}/api/ai/test-dispatch`, cookie, { workspaceId, permitId: queued.id });
    expect(stale.status).toBe(409);
    expect(stale.json).toEqual({ error: "conflict", reason: "permit_invalidated" });
    // Double-consume of history fails as consumed, not as success.
    const again = await call("POST", `${base}/api/ai/test-dispatch`, cookie, { workspaceId, permitId: first.id });
    expect(again.status).toBe(409);
    // Fresh permit carries the new version with the excluded account absent.
    const fresh = (await call("POST", `${base}/api/ai/permits`, cookie, { workspaceId, purpose: "p3" })).json as { policyVersion: string; eligibleAccountIds: string[] };
    expect(fresh.policyVersion).toBe("2");
    expect(fresh.eligibleAccountIds).toEqual([acctIn].sort());
    // Clearing the exclusion bumps again and restores eligibility.
    const clear = await call("PUT", `${base}/api/ai/exclusions`, cookie, { workspaceId, accountId: acctOut, excluded: false });
    expect((clear.json as { policyVersion: string }).policyVersion).toBe("3");
    const restored = (await call("POST", `${base}/api/ai/permits`, cookie, { workspaceId, purpose: "p4" })).json as { eligibleAccountIds: string[] };
    expect(restored.eligibleAccountIds.sort()).toEqual([acctIn, acctOut].sort());
  });

  it("unknown accounts are denied and permits never cover future accounts", async () => {
    const base = await startApp();
    const { cookie, workspaceId, acctIn } = await setupWorkspace(base, "synthetic-pol-c");
    const ghost = randomUUID();
    const denied = await call("POST", `${base}/api/ai/permits`, cookie, { workspaceId, purpose: "p", accountIds: [acctIn, ghost] });
    expect(denied.status).toBe(400);
    expect(denied.json).toEqual({ error: "invalid_request", reason: "unknown_account" });
    const exclGhost = await call("PUT", `${base}/api/ai/exclusions`, cookie, { workspaceId, accountId: ghost, excluded: true });
    expect(exclGhost.status).toBe(400);
    // A permit issued now cannot cover an account created afterwards.
    const permit = (await call("POST", `${base}/api/ai/permits`, cookie, { workspaceId, purpose: "p" })).json as { id: string; eligibleAccountIds: string[] };
    const late = await (await fetch(`${base}/api/accounts`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, name: "Late account" }),
    })).json() as { id: string };
    expect(permit.eligibleAccountIds).not.toContain(late.id);
    const sent = await call("POST", `${base}/api/ai/test-dispatch`, cookie, { workspaceId, permitId: permit.id });
    expect(sent.status).toBe(200);
    expect(JSON.stringify(sent.json)).not.toContain("Late account");
  });

  it("concurrent exclusion and issuance never stamps pre-change data with the post-change version", async () => {
    const base = await startApp();
    const { cookie, workspaceId, acctIn, acctOut } = await setupWorkspace(base, "synthetic-pol-f");
    const v0 = ((await call("GET", `${base}/api/ai/policy?workspaceId=${workspaceId}`, cookie)).json as { policyVersion: string }).policyVersion;
    // Fire the exclusion bump and five issuances without awaiting between
    // them: the policy lock serializes the snapshot, so every permit is
    // either fully before (old version, old eligibility) or fully after —
    // never old eligibility stamped with the new version (B1 leak signature).
    const toggle = call("PUT", `${base}/api/ai/exclusions`, cookie, { workspaceId, accountId: acctOut, excluded: true });
    const issued = await Promise.all(
      Array.from({ length: 5 }, () => call("POST", `${base}/api/ai/permits`, cookie, { workspaceId, purpose: "race" })),
    );
    const bumped = (await toggle).json as { policyVersion: string };
    expect(issued.every((r) => r.status === 201)).toBe(true);
    const permits = issued.map((r) => r.json as { id: string; policyVersion: string; eligibleAccountIds: string[] });
    for (const p of permits) {
      const hasOut = p.eligibleAccountIds.includes(acctOut);
      expect(hasOut ? p.policyVersion : "new").toBe(hasOut ? v0 : "new");
      expect(!hasOut || p.policyVersion !== bumped.policyVersion).toBe(true);
      expect(p.eligibleAccountIds).toContain(acctIn);
    }
    // And dispatching the pre-change permits after invalidation fails closed.
    for (const p of permits.filter((p) => p.policyVersion === v0)) {
      const sent = await call("POST", `${base}/api/ai/test-dispatch`, cookie, { workspaceId, permitId: p.id });
      expect(sent.status).toBe(409);
    }
  });

  it("serializes exclusion changes with dispatch start", async () => {
    const base = await startApp();
    const { workspaceId, acctOut } = await setupWorkspace(base, "synthetic-pol-dispatch-race");
    const userId = (await pool.query("SELECT id FROM users WHERE auth_subject = $1", ["synthetic-pol-dispatch-race"])).rows[0].id as string;
    const claims = { userId, workspaceId };
    const permit = await issuePermit(pool, claims, "dispatch-race");

    let reachedInvalidation!: () => void;
    let releaseInvalidation!: () => void;
    const invalidationReached = new Promise<void>((resolve) => { reachedInvalidation = resolve; });
    const invalidationRelease = new Promise<void>((resolve) => { releaseInvalidation = resolve; });
    const writerPool = new Proxy(pool, {
      get(target, property, receiver) {
        if (property !== "connect") return Reflect.get(target, property, receiver);
        return async () => {
          const client = await target.connect();
          const query = client.query.bind(client);
          client.query = (async (...args: Parameters<typeof query>) => {
            if (typeof args[0] === "string" && args[0].startsWith("UPDATE ai_dispatch_permits SET status = 'INVALIDATED'")) {
              reachedInvalidation();
              await invalidationRelease;
            }
            return query(...args);
          }) as typeof client.query;
          return client;
        };
      },
    }) as Pool;

    const exclusion = setAccountExclusion(writerPool, claims, userId, acctOut, true);
    await invalidationReached; // writer holds the policy row after its version bump
    let dispatchFinished = false;
    const dispatch = consumePermit(pool, claims, permit.id).then(
      () => { dispatchFinished = true; return undefined; },
      (error: unknown) => { dispatchFinished = true; return error; },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const finishedBeforeWriterCommitted = dispatchFinished;
    releaseInvalidation();
    await exclusion;
    expect(finishedBeforeWriterCommitted).toBe(false);
    await expect(dispatch).resolves.toMatchObject({ code: "permit_invalidated" });
  });

  it("no-op exclusion changes neither bump the version nor invalidate permits", async () => {
    const base = await startApp();
    const { cookie, workspaceId, acctOut } = await setupWorkspace(base, "synthetic-pol-g");
    const first = (await call("PUT", `${base}/api/ai/exclusions`, cookie, { workspaceId, accountId: acctOut, excluded: true })).json as { policyVersion: string };
    expect(first.policyVersion).toBe("2");
    const permit = (await call("POST", `${base}/api/ai/permits`, cookie, { workspaceId, purpose: "q" })).json as { id: string };
    const repeat = (await call("PUT", `${base}/api/ai/exclusions`, cookie, { workspaceId, accountId: acctOut, excluded: true })).json as { policyVersion: string };
    expect(repeat.policyVersion).toBe("2"); // unchanged, no invalidation
    const sent = await call("POST", `${base}/api/ai/test-dispatch`, cookie, { workspaceId, permitId: permit.id });
    expect(sent.status).toBe(200);
  });

  it("policy reads are tenant-isolated and versions increase monotonically", async () => {
    const base = await startApp();
    const a = await setupWorkspace(base, "synthetic-pol-d");
    const b = await setupWorkspace(base, "synthetic-pol-e");
    const policyB = await call("GET", `${base}/api/ai/policy?workspaceId=${b.workspaceId}`, a.cookie);
    expect(policyB.status).toBe(404); // foreign reads as missing, never forbidden
    const fresh = await call("GET", `${base}/api/ai/policy?workspaceId=${a.workspaceId}`, a.cookie);
    expect(fresh.json).toMatchObject({ policyVersion: "1", excludedAccountIds: [] });
    const versions: string[] = [];
    for (const [id, off] of [[a.acctIn, true], [a.acctOut, true], [a.acctOut, false]] as const) {
      const r = (await call("PUT", `${base}/api/ai/exclusions`, a.cookie, { workspaceId: a.workspaceId, accountId: id, excluded: off })).json as { policyVersion: string };
      versions.push(r.policyVersion);
    }
    expect(versions).toEqual(["2", "3", "4"]);
  });
});
