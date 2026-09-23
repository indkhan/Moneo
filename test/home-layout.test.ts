// E07-S03 pin and arrange persistent artifacts on the one Home dashboard.
// Real disposable PostgreSQL (`moneo_e07_home_layout`); deterministic only —
// no live provider, no browser engines (server-rendered native forms are
// asserted at the HTTP/markup layer: no script handlers, DOM order == tile
// order, 44px targets). Synthetic data only.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import { createTenancyRouter, withTenant, type TenantClaims } from "../apps/web/src/tenancy.ts";
import { createUiRouter } from "../apps/web/src/ui/routes.ts";
import { TxError } from "../apps/web/src/commands/transactions.ts";
import {
  activateArtifactVersion,
  createArtifactDraft,
  settleArtifactVersion,
  submitArtifactBuild,
  type ArtifactManifest,
} from "../apps/web/src/commands/artifacts.ts";
import { getArtifactState, patchArtifactState } from "../apps/web/src/commands/artifact-state.ts";
import {
  HOME_LAYOUT_MAX_TILES,
  moveTile,
  pinTile,
  readHomeLayout,
  resolveHomeTiles,
  resizeTile,
  unpinTile,
} from "../apps/web/src/commands/home-layout.ts";
import { readGrantBasis } from "../apps/web/src/artifact-ai.ts";
import { ensureTestPool, env } from "./helpers/test-db.ts";
import { startStubIssuer, STUB_CLIENT_ID, STUB_CLIENT_SECRET, type StubIssuer } from "./helpers/stub-issuer.ts";

let pool: Pool;
let stub: StubIssuer;
const appServers: Server[] = [];
const sessionSecret = randomBytes(32).toString("hex");

function manifest(): ArtifactManifest {
  return {
    artifactSdkVersion: "1",
    runtimeVersion: "1",
    sourceSchemaVersion: "1",
    stateSchemaVersion: "1",
    requestedPermissions: ["analytics.spending_by_category"],
    approvedPermissions: ["analytics.spending_by_category"],
    entrypoints: { full: "main", compact: "compact" },
    resourceBudget: { maxMessagesPerSecond: 100 },
    sourceHash: "",
    buildHash: "",
    createdByUser: "home-layout-test",
  };
}

const SOURCE = {
  html: '<section><h1>Tile chart</h1><div data-slot="chart"></div></section>',
  css: "section{font:16px system-ui}",
  js: 'artifact.ui.render({ type: "chart", rows: [] });',
};

async function startApp(): Promise<string> {
  const config: AuthConfig = {
    issuer: stub.base,
    clientId: STUB_CLIENT_ID,
    clientSecret: STUB_CLIENT_SECRET,
    appBaseUrl: "http://127.0.0.1:1",
    sessionSecret,
    sessionTtlSec: 43200,
  };
  const uiConfig = { appBaseUrl: "http://127.0.0.1:1", sessionSecret };
  const server = createApp(
    createAuthRouter(config, pool),
    createTenancyRouter(pool, (req) => requestSession(pool, sessionSecret, req)),
    {
      ui: createUiRouter(pool, (req) => requestSession(pool, sessionSecret, req), uiConfig),
      controls: null,
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  appServers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.appBaseUrl = base;
  uiConfig.appBaseUrl = base;
  return base;
}

async function login(base: string, loginAs: string): Promise<string> {
  const start = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const authorizeUrl = `${start.headers.get("location")!}&login_as=${loginAs}`;
  const callbackUrl = (await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!;
  const done = await fetch(callbackUrl, { redirect: "manual" });
  return done.headers.get("set-cookie")!.split(";")[0];
}

type Setup = { cookie: string; userId: string; workspaceId: string; claims: TenantClaims };

async function setupWorkspace(base: string, sub: string, suffix: string): Promise<Setup> {
  const cookie = await login(base, sub);
  const ws = (await (await fetch(`${base}/api/workspaces`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `LAYOUT-${suffix}`, baseCurrency: "EUR" }),
  })).json()) as { id: string };
  const userId = ((await pool.query("SELECT id FROM users WHERE auth_subject = $1", [sub])).rows[0] as { id: string }).id;
  return { cookie, userId, workspaceId: ws.id, claims: { userId, workspaceId: ws.id } };
}

async function get(cookie: string, url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { headers: { cookie } });
  return { status: res.status, text: await res.text() };
}

async function postLayout(base: string, cookie: string, workspaceId: string, body: Record<string, string>): Promise<{ status: number; text: string; location: string | null }> {
  const res = await fetch(`${base}/w/${workspaceId}/home/layout`, {
    method: "POST",
    headers: { cookie, origin: base, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    redirect: "manual",
  });
  return { status: res.status, text: await res.text(), location: res.headers.get("location") };
}

async function postJson(base: string, path: string, cookie: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function scoped<T>(claims: TenantClaims, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenant(pool, claims, work);
}

// Home renders "this month" for the CURRENT month: fixtures must live in it,
// or the month section honestly reports zero for another month's data.
function currentMonthDay(day: number): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const last = new Date(Date.UTC(y, now.getUTCMonth() + 1, 0)).getUTCDate();
  return `${y}-${m}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

async function makeReadyArtifact(claims: TenantClaims, name: string): Promise<{ artifactId: string; versionId: string }> {
  return scoped(claims, async (client) => {
    const { artifactId } = await createArtifactDraft(client, claims, name);
    const { versionId } = await submitArtifactBuild(client, claims, artifactId, SOURCE, manifest());
    await settleArtifactVersion(client, claims, artifactId, versionId, { ok: true });
    await activateArtifactVersion(client, claims, artifactId, versionId);
    return { artifactId, versionId };
  });
}

async function makeReadyVersion(claims: TenantClaims, artifactId: string): Promise<string> {
  return scoped(claims, async (client) => {
    const { versionId } = await submitArtifactBuild(client, claims, artifactId, { ...SOURCE, js: `${SOURCE.js}\n// v2` }, manifest());
    await settleArtifactVersion(client, claims, artifactId, versionId, { ok: true });
    await activateArtifactVersion(client, claims, artifactId, versionId);
    return versionId;
  });
}

async function revisionOf(claims: TenantClaims): Promise<string> {
  return scoped(claims, async (client) => {
    const rows = await client.query("SELECT revision AS r FROM workspace_data_revision WHERE workspace_id = $1", [claims.workspaceId]);
    return (rows.rowCount ?? 0) === 0 ? "0" : String((rows.rows[0] as { r: string }).r);
  });
}

async function expectTxError(promise: Promise<unknown>, code: string): Promise<TxError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(TxError);
    expect((err as TxError).code).toBe(code);
    return err as TxError;
  }
  throw new Error(`expected TxError ${code}, but the command succeeded`);
}

beforeAll(async () => {
  pool = await ensureTestPool("E07-S03", "moneo_e07_home_layout", [
    "home_layout_tiles",
    "home_layouts",
    "artifact_state_migrations",
    "artifact_state_snapshots",
    "artifact_state",
    "artifact_sdk_access_events",
    "artifact_runtime_grants",
    "artifact_build_attempts",
    "artifact_versions",
    "artifacts",
    "artifact_ai_proposals",
    "deep_analysis_findings",
    "deep_analysis_steps",
    "deep_analysis_runs",
    "scenario_overrides",
    "scenarios",
    "projection_runs",
    "projection_points",
    "projection_events",
    "projection_settings",
    "financial_assumptions",
    "goals",
    "goal_allocations",
    "recurring_overrides",
    "chat_tool_calls",
    "chat_activity",
    "chat_attempts",
    "chat_turns",
    "chat_threads",
    "ai_dispatch_usage",
    "ai_dispatch_reservations",
    "ai_dispatch_budgets",
    "manual_transactions",
    "balance_snapshots",
    "balance_audit",
    "mapping_provider_usage",
    "mapping_provider_reservations",
    "mapping_proposals",
    "mapping_profiles",
    "review_decisions",
    "source_links",
    "transactions",
    "import_commit_batches",
    "parsed_observations",
    "source_objects",
    "imports",
    "data_sources",
    "background_job_attempts",
    "job_dispatch_index",
    "outbox_events",
    "background_job_results",
    "background_jobs",
    "ai_dispatch_permits",
    "ai_exclusions",
    "ai_policies",
    "command_operations",
    "audit_events",
    "workspace_data_revision",
    "accounts",
    "workspace_members",
    "workspaces",
    "users",
    "app_sessions",
  ]);
  stub = await startStubIssuer();
  // Fail closed when the disposable database is unreachable: env() throws
  // naming only the missing variable, never a value.
  void env("E07-S03", "DATABASE_URL");
}, 120_000);

afterAll(async () => {
  if (stub) await stub.close();
  for (const server of appServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
});

describe("e07-s03 home layout", () => {
  it("two tabs saving from version 1 race to one success plus one 409 with the decimal-string current version; retry from fresh preserves both intents", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "layout-race", "race");
    const a = await makeReadyArtifact(setup.claims, "Race A");
    const b = await makeReadyArtifact(setup.claims, "Race B");

    // Both tabs read version "1" (fresh workspace: no layout row yet).
    const fresh = await readHomeLayout(pool, setup.claims);
    expect(fresh).toMatchObject({ version: "1", userEdited: false, tiles: [] });

    const first = await pinTile(pool, setup.claims, setup.userId, {
      workspaceId: setup.workspaceId,
      artifactId: a.artifactId,
      size: "small",
      expectedVersion: "1",
      idempotencyKey: randomUUID(),
    });
    expect(first.view.version).toBe("2");
    expect(first.view.tiles).toHaveLength(1);
    expect(first.replayed).toBe(false);

    // The stale tab loses with a 409 carrying the decimal-string version.
    const conflict = await expectTxError(
      pinTile(pool, setup.claims, setup.userId, {
        workspaceId: setup.workspaceId,
        artifactId: b.artifactId,
        size: "wide",
        expectedVersion: "1",
        idempotencyKey: randomUUID(),
      }),
      "version_mismatch",
    );
    expect(conflict.currentVersion).toBe("2");
    expect(/^[0-9]+$/.test(conflict.currentVersion!)).toBe(true);

    // Retry from fresh preserves both intents: A stays, B lands after it.
    const retry = await pinTile(pool, setup.claims, setup.userId, {
      workspaceId: setup.workspaceId,
      artifactId: b.artifactId,
      size: "wide",
      expectedVersion: conflict.currentVersion!,
      idempotencyKey: randomUUID(),
    });
    expect(retry.view.version).toBe("3");
    expect(retry.view.tiles.map((t) => t.artifactId)).toEqual([a.artifactId, b.artifactId]);
    expect(retry.view.userEdited).toBe(true);

    // Idempotent replay: the same key returns the stored view, no new tile, no version bump.
    const replay = await pinTile(pool, setup.claims, setup.userId, {
      workspaceId: setup.workspaceId,
      artifactId: b.artifactId,
      size: "wide",
      expectedVersion: "2",
      idempotencyKey: (await scoped(setup.claims, (c) => c.query("SELECT idempotency_key FROM command_operations WHERE workspace_id = $1 AND command_name = 'home-layout.pin' ORDER BY started_at DESC LIMIT 1", [setup.workspaceId]))).rows[0].idempotency_key,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.view.version).toBe("3");
    expect((await readHomeLayout(pool, setup.claims)).tiles).toHaveLength(2);
  });

  it("pin, reorder, resize and unpin survive reload and stay keyboard-only with DOM order equal to tile order", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "layout-keys", "keys");
    const a = await makeReadyArtifact(setup.claims, "Keys Alpha");
    const b = await makeReadyArtifact(setup.claims, "Keys Beta");

    let v = (await readHomeLayout(pool, setup.claims)).version;
    for (const [artifactId, size] of [[a.artifactId, "small"], [b.artifactId, "wide"]] as const) {
      const pinned = await postLayout(base, setup.cookie, setup.workspaceId, {
        action: "pin", artifactId, size, expectedVersion: v, idempotencyKey: randomUUID(),
      });
      expect(pinned.status).toBe(303);
      v = (await readHomeLayout(pool, setup.claims)).version;
    }

    // Move Beta above Alpha, then widen Alpha: both survive a plain reload.
    expect((await postLayout(base, setup.cookie, setup.workspaceId, {
      action: "move", artifactId: b.artifactId, toPosition: "0", expectedVersion: v, idempotencyKey: randomUUID(),
    })).status).toBe(303);
    v = (await readHomeLayout(pool, setup.claims)).version;
    expect((await postLayout(base, setup.cookie, setup.workspaceId, {
      action: "size", artifactId: a.artifactId, size: "large", expectedVersion: v, idempotencyKey: randomUUID(),
    })).status).toBe(303);

    const page = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home?customize=1`);
    expect(page.status).toBe(200);
    // Saved order + sizes render after reload.
    expect(page.text.indexOf("Keys Beta")).toBeLessThan(page.text.indexOf("Keys Alpha"));
    expect(page.text).toContain("(large)");
    expect(page.text).toContain("(wide)");
    expect(page.text).toContain("Layout version");
    expect(page.text).toContain("Move up");
    expect(page.text).toContain("Move down");
    expect(page.text).toContain("Apply size");
    expect(page.text).toContain("Customize mode");
    // Keyboard-only: native controls in DOM order, no script handlers, skip link, 44px floor.
    expect(page.text).not.toContain("<script");
    expect(page.text).not.toContain("onclick");
    expect(page.text).not.toContain("onkeydown");
    expect(page.text).toContain('href="#main"');
    expect(page.text).toContain("<select");
    expect((page.text.match(/min-height:44px/g) ?? []).length).toBeGreaterThanOrEqual(6);
    // Small-screen overflow: tiles cap at their size width and wrap anywhere.
    expect(page.text).toContain("max-width:");
    expect(page.text).toContain("overflow-wrap:anywhere");

    const plain = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home`);
    expect(plain.status).toBe(200);
    expect(plain.text).toContain("Customize");
    expect(plain.text).not.toContain("Move down");

    // Unpin Beta: Alpha alone remains after reload.
    v = (await readHomeLayout(pool, setup.claims)).version;
    expect((await postLayout(base, setup.cookie, setup.workspaceId, {
      action: "unpin", artifactId: b.artifactId, expectedVersion: v, idempotencyKey: randomUUID(),
    })).status).toBe(303);
    const after = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home`);
    expect(after.text).toContain("Keys Alpha");
    expect(after.text).not.toContain("Keys Beta");
  });

  it("rejects duplicate pins, enforces 12 tiles, validates sizes, and hides foreign artifacts uniformly", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "layout-limits", "limits");
    const first = await makeReadyArtifact(setup.claims, "Limits One");
    let v = (await readHomeLayout(pool, setup.claims)).version;
    v = (await pinTile(pool, setup.claims, setup.userId, {
      workspaceId: setup.workspaceId, artifactId: first.artifactId, size: "small", expectedVersion: v, idempotencyKey: randomUUID(),
    })).view.version;

    // No duplicate pin: 409 already_pinned with the current version.
    const dup = await expectTxError(
      pinTile(pool, setup.claims, setup.userId, {
        workspaceId: setup.workspaceId, artifactId: first.artifactId, size: "small", expectedVersion: v, idempotencyKey: randomUUID(),
      }),
      "unsupported_operation",
    );
    expect((dup.detail as { reason?: string } | undefined)?.reason).toBe("already_pinned");
    expect(dup.currentVersion).toBe(v);

    // Fill to the 12-tile ceiling, then refuse the 13th.
    const extra: string[] = [];
    for (let i = 0; i < HOME_LAYOUT_MAX_TILES - 1; i++) {
      extra.push((await makeReadyArtifact(setup.claims, `Limits Fill ${i}`)).artifactId);
    }
    for (const artifactId of extra) {
      v = (await pinTile(pool, setup.claims, setup.userId, {
        workspaceId: setup.workspaceId, artifactId, size: "small", expectedVersion: v, idempotencyKey: randomUUID(),
      })).view.version;
    }
    expect((await readHomeLayout(pool, setup.claims)).tiles).toHaveLength(HOME_LAYOUT_MAX_TILES);
    const overflow = await makeReadyArtifact(setup.claims, "Limits Overflow");
    const capped = await expectTxError(
      pinTile(pool, setup.claims, setup.userId, {
        workspaceId: setup.workspaceId, artifactId: overflow.artifactId, size: "small", expectedVersion: v, idempotencyKey: randomUUID(),
      }),
      "limit_exceeded",
    );
    expect(capped.currentVersion).toBe(v);

    // Bad size is a 400-class validation failure, never a row write.
    await expect(
      pinTile(pool, setup.claims, setup.userId, {
        workspaceId: setup.workspaceId, artifactId: overflow.artifactId, size: "huge", expectedVersion: v, idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
    // Moving or resizing a pin that is not there reads exactly like missing.
    await expectTxError(moveTile(pool, setup.claims, setup.userId, {
      workspaceId: setup.workspaceId, artifactId: overflow.artifactId, toPosition: "0", expectedVersion: v, idempotencyKey: randomUUID(),
    }), "not_found");
    await expectTxError(resizeTile(pool, setup.claims, setup.userId, {
      workspaceId: setup.workspaceId, artifactId: overflow.artifactId, size: "wide", expectedVersion: v, idempotencyKey: randomUUID(),
    }), "not_found");
    await expectTxError(unpinTile(pool, setup.claims, setup.userId, {
      workspaceId: setup.workspaceId, artifactId: overflow.artifactId, expectedVersion: v, idempotencyKey: randomUUID(),
    }), "not_found");

    // Cross-tenant pin reads exactly like a missing artifact: uniform 404, no oracle.
    const other = await setupWorkspace(base, "layout-limits-other", "limits-other");
    await expectTxError(pinTile(pool, other.claims, other.userId, {
      workspaceId: other.workspaceId, artifactId: first.artifactId, size: "small", expectedVersion: "1", idempotencyKey: randomUUID(),
    }), "not_found");
    // Pinning an artifact with no ready version is a 409, not a silent skip.
    const draft = await scoped(other.claims, (client) => createArtifactDraft(client, other.claims, "Never ready"));
    await expectTxError(pinTile(pool, other.claims, other.userId, {
      workspaceId: other.workspaceId, artifactId: draft.artifactId, size: "small", expectedVersion: "1", idempotencyKey: randomUUID(),
    }), "unsupported_operation");
  });

  it("a newer artifact version reopens with current authorized data plus saved state, and a second import refreshes Home without touching the layout", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "layout-reopen", "reopen");
    const art = await makeReadyArtifact(setup.claims, "Reopen Chart");
    let v = (await readHomeLayout(pool, setup.claims)).version;
    v = (await pinTile(pool, setup.claims, setup.userId, {
      workspaceId: setup.workspaceId, artifactId: art.artifactId, size: "small", expectedVersion: v, idempotencyKey: randomUUID(),
    })).view.version;

    // Publish + activate v2: the pin follows the artifact, not the version.
    const v2 = await makeReadyVersion(setup.claims, art.artifactId);
    const resolved = await resolveHomeTiles(pool, setup.claims);
    expect(resolved.tiles).toHaveLength(1);
    expect(resolved.tiles[0]).toMatchObject({ artifactId: art.artifactId, status: "available", activeVersionId: v2 });
    const home = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home`);
    expect(home.status).toBe(200);
    expect(home.text).toContain("Reopen Chart");
    // Compact preview resolves the CURRENT active version, never a stale one.
    expect(home.text).toContain(`/artifacts/${art.artifactId}/versions/${v2}/compact`);
    expect(home.text).not.toContain(art.versionId);

    // Saved state round-trips across the reopen.
    await scoped(setup.claims, (client) => patchArtifactState(client, setup.claims, art.artifactId, [{ op: "add", path: "months", value: 6 }], 1));
    const state = await scoped(setup.claims, (client) => getArtifactState(client, setup.claims, art.artifactId));
    expect(state).toMatchObject({ state: { months: 6 }, versionId: expect.any(String) });

    // Opening the tile mints a fresh grant on the current policy/data basis.
    const basis = await scoped(setup.claims, (client) => readGrantBasis(client, setup.workspaceId));
    const opened = await postJson(base, "/api/artifacts/sessions", setup.cookie, {
      workspaceId: setup.workspaceId, artifactId: art.artifactId, versionId: v2, initialState: {},
    });
    expect(opened.status).toBe(201);
    const sessionId = (opened.json as { sessionId: string }).sessionId;
    const grant = await scoped(setup.claims, (client) =>
      client.query("SELECT data_revision, policy_revision FROM artifact_runtime_grants WHERE workspace_id = $1 AND session_id = $2", [setup.workspaceId, sessionId]),
    );
    expect(String((grant.rows[0] as { data_revision: string }).data_revision)).toBe(basis.dataRevision);
    expect(String((grant.rows[0] as { policy_revision: string }).policy_revision)).toBe(basis.policyVersion);
    await fetch(`${base}/api/artifacts/sessions/${sessionId}`, { method: "DELETE", headers: { cookie: setup.cookie } });

    // A second import refreshes trusted metrics on reload; the layout version is untouched.
    const layoutBefore = (await readHomeLayout(pool, setup.claims)).version;
    await scoped(setup.claims, async (client) => {
      const accountId = randomUUID();
      await client.query("INSERT INTO accounts (workspace_id, id, name, base_currency_code) VALUES ($1, $2, 'Second-import', 'EUR')", [setup.workspaceId, accountId]);
      await client.query(
        "INSERT INTO transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, import_id, import_row_no, observation_id) VALUES ($1, $2, $3, '42000', 'EUR', 'INFLOW', $5, 'Second import salary', $4, 1, 'obs-1')",
        [setup.workspaceId, randomUUID(), accountId, randomUUID(), currentMonthDay(10)],
      );
    });
    const refreshed = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.text).toContain("42000 minor EUR");
    expect((await readHomeLayout(pool, setup.claims)).version).toBe(layoutBefore);
    void v;
  });

  it("archived or version-less pins render as removable unavailable tiles without executing anything; stale grants never run", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "layout-stale", "stale");
    const art = await makeReadyArtifact(setup.claims, "Stale Chart");
    let v = (await readHomeLayout(pool, setup.claims)).version;
    v = (await pinTile(pool, setup.claims, setup.userId, {
      workspaceId: setup.workspaceId, artifactId: art.artifactId, size: "wide", expectedVersion: v, idempotencyKey: randomUUID(),
    })).view.version;

    // Open a live session, then change the world: pinning bumps the data
    // revision, so the open grant goes stale and its next SDK call is
    // denied before any query runs.
    const opened = await postJson(base, "/api/artifacts/sessions", setup.cookie, {
      workspaceId: setup.workspaceId, artifactId: art.artifactId, versionId: art.versionId, initialState: {},
    });
    expect(opened.status).toBe(201);
    const sessionId = (opened.json as { sessionId: string }).sessionId;
    const bump = await makeReadyArtifact(setup.claims, "Stale Bumper");
    v = (await pinTile(pool, setup.claims, setup.userId, {
      workspaceId: setup.workspaceId, artifactId: bump.artifactId, size: "small", expectedVersion: v, idempotencyKey: randomUUID(),
    })).view.version;
    const staleCall = await postJson(base, "/api/artifacts/sdk/rpc", setup.cookie, {
      sessionId, method: "spendingByCategory", args: {},
    });
    expect(staleCall.status).toBe(409);
    expect(staleCall.json).toMatchObject({ error: "conflict", reason: "grant_stale" });
    await fetch(`${base}/api/artifacts/sessions/${sessionId}`, { method: "DELETE", headers: { cookie: setup.cookie } });

    // Archive the pinned artifact: Home renders an unavailable, removable
    // tile — no iframe, no script, no stale code, no finance payload.
    await scoped(setup.claims, (client) => client.query("UPDATE artifacts SET archived_at = now() WHERE workspace_id = $1 AND id = $2", [setup.workspaceId, art.artifactId]));
    const page = await get(setup.cookie, `${base}/w/${setup.workspaceId}/home?customize=1`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Stale Chart");
    expect(page.text).toContain("unavailable (archived)");
    expect(page.text).toContain("Remove");
    expect(page.text).not.toContain("<iframe");
    expect(page.text).not.toContain("<script");
    // The archived pin offers no Open path.
    expect(page.text).not.toContain(`/artifacts/${art.artifactId}?tab=preview`);

    // Remove the dead pin; the surviving pin keeps its saved slot.
    v = (await readHomeLayout(pool, setup.claims)).version;
    expect((await postLayout(base, setup.cookie, setup.workspaceId, {
      action: "unpin", artifactId: art.artifactId, expectedVersion: v, idempotencyKey: randomUUID(),
    })).status).toBe(303);
    const remaining = await readHomeLayout(pool, setup.claims);
    expect(remaining.tiles.map((t) => t.artifactId)).toEqual([bump.artifactId]);
    expect(remaining.tiles[0]!.position).toBe(0);
  });

  it("every layout mutation is journaled, audited and revision-bumped; unscoped reads see zero rows and RLS is forced", async () => {
    const base = await startApp();
    const setup = await setupWorkspace(base, "layout-audit", "audit");
    const art = await makeReadyArtifact(setup.claims, "Audit Chart");
    const revBefore = await revisionOf(setup.claims);

    const pinned = await pinTile(pool, setup.claims, setup.userId, {
      workspaceId: setup.workspaceId, artifactId: art.artifactId, size: "small", expectedVersion: "1", idempotencyKey: randomUUID(),
    });
    expect(await revisionOf(setup.claims)).toBe((BigInt(revBefore) + 1n).toString(10));
    const journal = await scoped(setup.claims, (client) =>
      client.query("SELECT status FROM command_operations WHERE workspace_id = $1 AND id = $2", [setup.workspaceId, pinned.operationId]),
    );
    expect((journal.rows[0] as { status: string }).status).toBe("SUCCEEDED");
    const audit = await scoped(setup.claims, (client) =>
      client.query("SELECT entity_type, action, operation_id FROM audit_events WHERE workspace_id = $1 AND entity_type = 'home_layout' ORDER BY created_at", [setup.workspaceId]),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ entity_type: "home_layout", action: "pin", operation_id: pinned.operationId });

    await moveTile(pool, setup.claims, setup.userId, {
      workspaceId: setup.workspaceId, artifactId: art.artifactId, toPosition: "0", expectedVersion: pinned.view.version, idempotencyKey: randomUUID(),
    });
    await resizeTile(pool, setup.claims, setup.userId, {
      workspaceId: setup.workspaceId, artifactId: art.artifactId, size: "large", expectedVersion: (await readHomeLayout(pool, setup.claims)).version, idempotencyKey: randomUUID(),
    });
    const actions = await scoped(setup.claims, (client) =>
      client.query("SELECT action FROM audit_events WHERE workspace_id = $1 AND entity_type = 'home_layout' ORDER BY created_at", [setup.workspaceId]),
    );
    expect(actions.rows.map((r: { action: string }) => r.action)).toEqual(["pin", "move", "resize"]);
    expect(await revisionOf(setup.claims)).toBe((BigInt(revBefore) + 3n).toString(10));

    // Unscoped pooled reads fail closed to zero rows on both layout tables.
    const bare = await pool.connect();
    try {
      for (const table of ["home_layouts", "home_layout_tiles"]) {
        const r = await bare.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect((r.rows[0] as { n: number }).n).toBe(0);
      }
    } finally {
      bare.release();
    }
    // RLS is forced on both tables under the least-privilege app role.
    const role = await pool.query("SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user");
    expect(role.rows[0]).toMatchObject({ super: false, bypass: false });
    const forced = await pool.query("SELECT relname FROM pg_class WHERE relname IN ('home_layouts', 'home_layout_tiles') AND relforcerowsecurity");
    expect(forced.rows).toHaveLength(2);
    // A second tenant sees none of this workspace's layout or pins.
    const other = await setupWorkspace(base, "layout-audit-other", "audit-other");
    await scoped(other.claims, async (client) => {
      expect(((await client.query("SELECT count(*)::int AS n FROM home_layout_tiles")).rows[0] as { n: number }).n).toBe(0);
      expect(((await client.query("SELECT count(*)::int AS n FROM home_layouts")).rows[0] as { n: number }).n).toBe(0);
    });
  });

  it("migration 039 rolls back and re-applies on the suite database", async () => {
    const { readFileSync } = await import("node:fs");
    const admin = await pool.connect();
    try {
      await admin.query("BEGIN");
      await admin.query(readFileSync("apps/web/migrations/039_home_layout.rollback.sql", "utf8"));
      await admin.query("COMMIT");
    } catch (err) {
      try {
        await admin.query("ROLLBACK");
      } catch { /* preserve */ }
      throw err;
    } finally {
      admin.release();
    }
    const gone = await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('home_layouts', 'home_layout_tiles')");
    expect((gone.rows[0] as { n: number }).n).toBe(0);
    // Re-apply just this migration: drop its version row so the idempotent
    // migrator restores the shape without touching sibling suites' rows.
    await pool.query("DELETE FROM schema_migrations WHERE version = '039_home_layout'");
    const { migrate } = await import("../apps/web/src/db.ts");
    await migrate(pool, "apps/web/migrations");
    const back = await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('home_layouts', 'home_layout_tiles')");
    expect((back.rows[0] as { n: number }).n).toBe(2);
    const recorded = await pool.query("SELECT 1 FROM schema_migrations WHERE version = '039_home_layout'");
    expect(recorded.rowCount).toBe(1);
  });
});
