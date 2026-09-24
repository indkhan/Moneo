// E05-S05 manual editor: server-rendered list/detail with Preview/Code/
// Data/Activity/Versions tabs, native forms for create/publish/activate,
// compact/full sandbox preview pages. Real PG (own `moneo_e05_artifact_ui`
// DB), stub issuer for auth. Synthetic artifact source only.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import type { Session } from "../apps/web/src/session-store.ts";
import { createTenancyRouter, withTenant } from "../apps/web/src/tenancy.ts";
import { getArtifactSession } from "../apps/web/src/artifact-host.ts";
import { createUiRouter } from "../apps/web/src/ui/routes.ts";
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
  const uiConfig = { appBaseUrl: "http://127.0.0.1:1", sessionSecret };
  const resolve = (req: import("node:http").IncomingMessage): Promise<Session | null> =>
    requestSession(pool, sessionSecret, req);
  const server = createApp(createAuthRouter(config, pool), createTenancyRouter(pool, resolve), {
    ui: createUiRouter(pool, resolve, uiConfig),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
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

async function setupWorkspace(base: string, cookie: string, name: string): Promise<string> {
  const res = await fetch(`${base}/api/workspaces`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name, baseCurrency: "EUR" }),
  });
  const body = (await res.json()) as { id: string };
  return body.id;
}

function form(body: Record<string, string>): { payload: string; headers: Record<string, string> } {
  return { payload: new URLSearchParams(body).toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" } };
}

async function postForm(base: string, path: string, cookie: string, body: Record<string, string>): Promise<{ status: number; text: string; location: string | null }> {
  const f = form(body);
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, origin: base, ...f.headers },
    body: f.payload,
    redirect: "manual",
  });
  return { status: res.status, text: await res.text(), location: res.headers.get("location") };
}

async function apiCreateDraft(base: string, cookie: string, workspaceId: string, name: string): Promise<string> {
  const res = await fetch(`${base}/api/artifacts`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, name }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { artifactId: string };
  return body.artifactId;
}

async function apiListVersions(base: string, cookie: string, workspaceId: string, artifactId: string): Promise<Array<{ versionId: string; status: string }>> {
  const res = await fetch(`${base}/api/artifacts/${artifactId}/versions?workspaceId=${workspaceId}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { versions: Array<{ versionId: string; status: string }> };
  return body.versions;
}

async function apiGetArtifact(base: string, cookie: string, workspaceId: string, artifactId: string): Promise<{ activeVersionId?: string; updatedAt: string }> {
  const res = await fetch(`${base}/api/artifacts/${artifactId}?workspaceId=${workspaceId}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as { activeVersionId?: string; updatedAt: string };
}

const VALID = {
  html: '<section><h1>Spending chart</h1><div data-slot="chart"></div><label>Months <input data-action="months" type="range" min="1" max="12" value="6"></label><output data-slot="value"></output></section>',
  css: "section{font:16px system-ui;padding:1rem}",
  js: "artifact.ui.render({ type: \"chart\", rows: [] });\nglobalThis.onEvent = function(e){ artifact.ui.patch({ slot: \"value\", text: String(e.value) }); };",
  manifest: JSON.stringify({
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
    createdByUser: "ui-test",
  }),
};

const HOSTILE_JS = "fetch(\"https://evil.invalid/x\");\nartifact.ui.render({ type: \"chart\", rows: [] });";

beforeAll(async () => {
  pool = await ensureTestPool("E05-S05", "moneo_e05_artifact_ui", [
    "artifact_state_migrations",
    "artifact_state_snapshots",
    "artifact_state",
    "artifact_sdk_access_events",
    "artifact_runtime_grants",
    "artifact_build_attempts",
    "artifact_versions",
    "artifacts",
    "recurring_overrides",
    "transaction_tags",
    "audit_events",
    "tags",
    "categories",
    "workspace_data_revision",
    "calculation_versions",
    "fx_valuation",
    "fx_rates_ecb",
    "fx_rates_manual",
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

describe("e05-s05 artifact editor", () => {
  it("lists, creates, publishes, previews compact/full and reopens the active version", async () => {
    const base = await startApp();
    const cookie = await login(base, "synthetic-artifact-editor-a");
    const ws = await setupWorkspace(base, cookie, "Artifact WS");

    // List is empty with a create link.
    const list = await fetch(`${base}/w/${ws}/artifacts`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const listHtml = await list.text();
    expect(listHtml).toContain("Artifacts");
    expect(listHtml).toContain("Create new artifact");
    expect(listHtml).toContain('href="#main"');

    // Create via UI form.
    const created = await postForm(base, `/w/${ws}/artifacts`, cookie, { name: "Spending chart", description: "Q1 view" });
    expect(created.status).toBe(303);
    expect(created.location).toMatch(/\/artifacts\/[0-9a-f-]+\?tab=code$/);
    const artifactId = created.location!.split("/artifacts/")[1].split("?")[0];

    // Code tab shows bounded editors, permissions note and base version field.
    const code = await fetch(`${base}/w/${ws}/artifacts/${artifactId}?tab=code`, { headers: { cookie } });
    expect(code.status).toBe(200);
    const codeHtml = await code.text();
    for (const needle of ["artifact.html", "artifact.css", "artifact.js", "artifact.manifest.json", "expectedBaseVersionId", "Validate only", "Validate and publish", "balances.read"]) {
      expect(codeHtml).toContain(needle);
    }
    // Labels are associated; tabs are keyboard links with aria-current.
    expect(codeHtml).toContain('for="code-html"');
    expect(codeHtml).toContain('aria-current="page"');

    // Publish the valid fixture.
    const published = await postForm(base, `/w/${ws}/artifacts/${artifactId}/versions`, cookie, {
      html: VALID.html,
      css: VALID.css,
      js: VALID.js,
      manifest: VALID.manifest,
      expectedBaseVersionId: "",
      action: "publish",
    });
    expect(published.status).toBe(303);
    expect(published.location).toContain("notice=published");

    const versions = await apiListVersions(base, cookie, ws, artifactId);
    expect(versions).toHaveLength(1);
    expect(versions[0].status).toBe("ready");
    const versionId = versions[0].versionId;

    // Versions tab shows hash, creator and time.
    const versionsPage = await fetch(`${base}/w/${ws}/artifacts/${artifactId}?tab=versions`, { headers: { cookie } });
    const versionsHtml = await versionsPage.text();
    expect(versionsHtml).toContain("Version history");
    expect(versionsHtml).toMatch(/[0-9a-f]{12}/);
    expect(versionsHtml).toContain("ui-test");

    // Data tab shows permissions.
    const data = await fetch(`${base}/w/${ws}/artifacts/${artifactId}?tab=data`, { headers: { cookie } });
    expect((await data.text())).toContain("analytics.spending_by_category");

    // Activate, then compact/full previews expose the sandbox iframe and Stop.
    const art = await apiGetArtifact(base, cookie, ws, artifactId);
    const activated = await postForm(base, `/w/${ws}/artifacts/${artifactId}/activate`, cookie, {
      versionId,
      expectedActiveVersionId: art.activeVersionId ?? "",
    });
    expect(activated.status).toBe(303);

    for (const [mode, width] of [["compact", "320"], ["full", "800"]] as const) {
      const view = await fetch(`${base}/w/${ws}/artifacts/${artifactId}/versions/${versionId}/${mode}`, { headers: { cookie } });
      expect(view.status).toBe(200);
      const viewHtml = await view.text();
      expect(viewHtml).toContain('id="art-frame"');
      expect(viewHtml).toContain(`width="${width}"`);
      expect(viewHtml).toContain('id="art-stop"');
      expect(viewHtml).toContain('aria-live="polite"');
      expect(viewHtml).toContain('sandbox="allow-scripts allow-same-origin"');
    }

    // Reopen shows the same active version.
    const reopened = await apiGetArtifact(base, cookie, ws, artifactId);
    expect(reopened.activeVersionId).toBe(versionId);
  });

  it("validate-only reports errors without creating a version", async () => {
    const base = await startApp();
    const cookie = await login(base, "synthetic-artifact-editor-b");
    const ws = await setupWorkspace(base, cookie, "Validate WS");
    const artifactId = await apiCreateDraft(base, cookie, ws, "Validate me");

    const before = await apiListVersions(base, cookie, ws, artifactId);
    const checked = await postForm(base, `/w/${ws}/artifacts/${artifactId}/versions`, cookie, {
      html: VALID.html,
      css: VALID.css,
      js: HOSTILE_JS,
      manifest: VALID.manifest,
      expectedBaseVersionId: "",
      action: "validate",
    });
    expect(checked.status).toBe(400);
    expect(checked.text).toContain("Validation failed");
    expect(checked.text).toContain("js_rejected");
    expect(checked.text).toContain("fetch");

    const after = await apiListVersions(base, cookie, ws, artifactId);
    expect(after).toHaveLength(before.length);
  });

  it("invalid publish records a failed version and preserves the active pair", async () => {
    const base = await startApp();
    const cookie = await login(base, "synthetic-artifact-editor-c");
    const ws = await setupWorkspace(base, cookie, "Failed build WS");
    const artifactId = await apiCreateDraft(base, cookie, ws, "Good then bad");

    // Publish a good version and activate it.
    const good = await postForm(base, `/w/${ws}/artifacts/${artifactId}/versions`, cookie, {
      ...VALID,
      expectedBaseVersionId: "",
      action: "publish",
    });
    expect(good.status).toBe(303);
    const versions = await apiListVersions(base, cookie, ws, artifactId);
    const goodId = versions[0].versionId;
    const art = await apiGetArtifact(base, cookie, ws, artifactId);
    const activated = await postForm(base, `/w/${ws}/artifacts/${artifactId}/activate`, cookie, {
      versionId: goodId,
      expectedActiveVersionId: art.activeVersionId ?? "",
    });
    expect(activated.status).toBe(303);

    // Publish hostile code: failed version recorded, active unchanged.
    const bad = await postForm(base, `/w/${ws}/artifacts/${artifactId}/versions`, cookie, {
      html: VALID.html,
      css: VALID.css,
      js: HOSTILE_JS,
      manifest: VALID.manifest,
      expectedBaseVersionId: goodId,
      action: "publish",
    });
    expect(bad.status).toBe(303);
    expect(bad.location).toContain("notice=failed");

    const afterVersions = await apiListVersions(base, cookie, ws, artifactId);
    expect(afterVersions).toHaveLength(2);
    expect(afterVersions.some((v) => v.status === "failed")).toBe(true);
    const afterArt = await apiGetArtifact(base, cookie, ws, artifactId);
    expect(afterArt.activeVersionId).toBe(goodId);
  });

  it("stale base publish conflicts with preserved source", async () => {
    const base = await startApp();
    const cookie = await login(base, "synthetic-artifact-editor-d");
    const ws = await setupWorkspace(base, cookie, "Stale WS");
    const artifactId = await apiCreateDraft(base, cookie, ws, "Stale chart");

    const first = await postForm(base, `/w/${ws}/artifacts/${artifactId}/versions`, cookie, {
      ...VALID,
      expectedBaseVersionId: "",
      action: "publish",
    });
    expect(first.status).toBe(303);
    const v1 = (await apiListVersions(base, cookie, ws, artifactId))[0].versionId;

    const second = await postForm(base, `/w/${ws}/artifacts/${artifactId}/versions`, cookie, {
      ...VALID,
      js: VALID.js.replace("rows: []", "rows: [] // v2"),
      expectedBaseVersionId: v1,
      action: "publish",
    });
    expect(second.status).toBe(303);

    const staleLabel = "STALE-LABEL-" + randomUUID().slice(0, 8);
    const stale = await postForm(base, `/w/${ws}/artifacts/${artifactId}/versions`, cookie, {
      html: VALID.html.replace("Spending chart", staleLabel),
      css: VALID.css,
      js: VALID.js,
      manifest: VALID.manifest,
      expectedBaseVersionId: v1,
      action: "publish",
    });
    expect(stale.status).toBe(409);
    expect(stale.text).toContain("Stale base version");
    expect(stale.text).toContain(staleLabel);
  });

  it("stale activation conflicts without mutation", async () => {
    const base = await startApp();
    const cookie = await login(base, "synthetic-artifact-editor-e");
    const ws = await setupWorkspace(base, cookie, "Activate WS");
    const artifactId = await apiCreateDraft(base, cookie, ws, "Activate me");

    const p1 = await postForm(base, `/w/${ws}/artifacts/${artifactId}/versions`, cookie, { ...VALID, expectedBaseVersionId: "", action: "publish" });
    expect(p1.status).toBe(303);
    const v1 = (await apiListVersions(base, cookie, ws, artifactId))[0].versionId;
    const a1 = await postForm(base, `/w/${ws}/artifacts/${artifactId}/activate`, cookie, { versionId: v1, expectedActiveVersionId: "" });
    expect(a1.status).toBe(303);

    const p2 = await postForm(base, `/w/${ws}/artifacts/${artifactId}/versions`, cookie, {
      ...VALID,
      js: VALID.js + "\n// v2",
      expectedBaseVersionId: v1,
      action: "publish",
    });
    expect(p2.status).toBe(303);
    const v2 = (await apiListVersions(base, cookie, ws, artifactId)).find((v) => v.versionId !== v1)!.versionId;
    const a2 = await postForm(base, `/w/${ws}/artifacts/${artifactId}/activate`, cookie, { versionId: v2, expectedActiveVersionId: v1 });
    expect(a2.status).toBe(303);

    const stale = await postForm(base, `/w/${ws}/artifacts/${artifactId}/activate`, cookie, { versionId: v1, expectedActiveVersionId: v1 });
    expect(stale.status).toBe(404);
    const art = await apiGetArtifact(base, cookie, ws, artifactId);
    expect(art.activeVersionId).toBe(v2);
  });

  it("rename is optimistic and cross-tenant access fails closed", async () => {
    const base = await startApp();
    const cookieA = await login(base, "synthetic-artifact-editor-f");
    const wsA = await setupWorkspace(base, cookieA, "WS A");
    const artifactId = await apiCreateDraft(base, cookieA, wsA, "Old name");
    const before = await apiGetArtifact(base, cookieA, wsA, artifactId);

    const renamed = await postForm(base, `/w/${wsA}/artifacts/${artifactId}/rename`, cookieA, {
      name: "New name",
      description: "Updated",
      expectedUpdatedAt: before.updatedAt,
    });
    expect(renamed.status).toBe(303);
    const detail = await fetch(`${base}/w/${wsA}/artifacts/${artifactId}?tab=preview`, { headers: { cookie: cookieA } });
    expect(await detail.text()).toContain("New name");

    const staleRename = await postForm(base, `/w/${wsA}/artifacts/${artifactId}/rename`, cookieA, {
      name: "Stale name",
      description: "",
      expectedUpdatedAt: before.updatedAt,
    });
    expect(staleRename.status).toBe(409);

    const cookieB = await login(base, "synthetic-artifact-editor-g");
    const wsB = await setupWorkspace(base, cookieB, "WS B");
    void wsB;
    const foreignDetail = await fetch(`${base}/w/${wsA}/artifacts/${artifactId}?tab=code`, { headers: { cookie: cookieB } });
    expect(foreignDetail.status).toBe(404);
    const foreignPublish = await postForm(base, `/w/${wsA}/artifacts/${artifactId}/versions`, cookieB, {
      ...VALID,
      expectedBaseVersionId: "",
      action: "publish",
    });
    expect(foreignPublish.status).toBe(404);

    const anon = await fetch(`${base}/w/${wsA}/artifacts`, { redirect: "manual" });
    expect(anon.status).toBe(401);
  });
});

describe("e05 adversarial fixes: state, snapshots, build gates, archived grants, quotas", () => {
  async function postJson(base: string, path: string, cookie: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  async function getJson(base: string, path: string, cookie: string): Promise<{ status: number; json: any }> {
    const res = await fetch(`${base}${path}`, { headers: { cookie } });
    return { status: res.status, json: await res.json() };
  }

  async function patchJson(base: string, path: string, cookie: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${base}${path}`, {
      method: "PATCH",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  async function publish(base: string, cookie: string, ws: string, artifactId: string, expectedBase: string, js = VALID.js): Promise<string> {
    const before = new Set((await apiListVersions(base, cookie, ws, artifactId)).map((v) => v.versionId));
    const r = await postForm(base, `/w/${ws}/artifacts/${artifactId}/versions`, cookie, {
      html: VALID.html,
      css: VALID.css,
      js,
      manifest: VALID.manifest,
      expectedBaseVersionId: expectedBase,
      action: "publish",
    });
    expect(r.status).toBe(303);
    const after = await apiListVersions(base, cookie, ws, artifactId);
    const fresh = after.find((v) => !before.has(v.versionId) && v.status === "ready");
    expect(fresh).toBeTruthy();
    return fresh!.versionId;
  }

  async function activate(base: string, cookie: string, ws: string, artifactId: string, versionId: string, expectedActive: string): Promise<void> {
    const r = await postForm(base, `/w/${ws}/artifacts/${artifactId}/activate`, cookie, {
      versionId,
      expectedActiveVersionId: expectedActive,
    });
    expect(r.status).toBe(303);
  }

  it("state patch first-insert works, bumps versions, and snapshots round-trip with compatible revert", async () => {
    const base = await startApp();
    const cookie = await login(base, "synthetic-artifact-fix-a");
    const ws = await setupWorkspace(base, cookie, "State WS");
    const artifactId = await apiCreateDraft(base, cookie, ws, "Stateful");
    const v1 = await publish(base, cookie, ws, artifactId, "");
    await activate(base, cookie, ws, artifactId, v1, "");

    // First patch creates the row anchored to the active version (FK-safe).
    const p1 = await patchJson(base, "/api/artifacts/state", cookie, {
      workspaceId: ws,
      artifactId,
      patches: [{ op: "add", path: "months", value: 6 }],
      expectedVersion: 1,
    });
    expect(p1.status).toBe(200);
    expect(p1.json).toMatchObject({ state: { months: 6 }, schemaVersion: 1 });

    // Second patch bumps the version; stale replays conflict.
    const p2 = await patchJson(base, "/api/artifacts/state", cookie, {
      workspaceId: ws,
      artifactId,
      patches: [{ op: "replace", path: "months", value: 3 }],
      expectedVersion: 1,
    });
    expect(p2.status).toBe(200);
    expect(p2.json.schemaVersion).toBe(2);
    const stale = await patchJson(base, "/api/artifacts/state", cookie, {
      workspaceId: ws,
      artifactId,
      patches: [{ op: "replace", path: "months", value: 9 }],
      expectedVersion: 1,
    });
    expect(stale.status).toBe(409);

    // Snapshot the current state, mutate, then revert to the snapshot.
    const snap = await postJson(base, `/api/artifacts/${artifactId}/state/snapshots`, cookie, { workspaceId: ws });
    expect(snap.status).toBe(201);
    const snapshotId = snap.json.id as string;
    const got = await getJson(base, `/api/artifacts/state/snapshots/${snapshotId}?workspaceId=${ws}&artifactId=${artifactId}`, cookie);
    expect(got.status).toBe(200);
    expect(got.json.state).toMatchObject({ months: 3 });
    const unknownSnap = await getJson(base, `/api/artifacts/state/snapshots/${randomUUID()}?workspaceId=${ws}&artifactId=${artifactId}`, cookie);
    expect(unknownSnap.status).toBe(404);
    // Snapshot ids are not interchangeable with artifact ids.
    const swapped = await getJson(base, `/api/artifacts/state/snapshots/${snapshotId}?workspaceId=${ws}&artifactId=${randomUUID()}`, cookie);
    expect(swapped.status).toBe(404);

    const p3 = await patchJson(base, "/api/artifacts/state", cookie, {
      workspaceId: ws,
      artifactId,
      patches: [{ op: "replace", path: "months", value: 12 }],
      expectedVersion: 2,
    });
    expect(p3.status).toBe(200);
    const reverted = await postJson(base, `/api/artifacts/${artifactId}/state/revert`, cookie, { workspaceId: ws, snapshotId });
    expect(reverted.status).toBe(200);
    expect(reverted.json.state).toMatchObject({ months: 3 });

    // Foreign artifact ids read as missing, never 500.
    const foreign = await patchJson(base, "/api/artifacts/state", cookie, {
      workspaceId: ws,
      artifactId: randomUUID(),
      patches: [{ op: "add", path: "x", value: 1 }],
      expectedVersion: 1,
    });
    expect(foreign.status).toBe(404);

    // A draft with no versions has no anchor for state.
    const bare = await apiCreateDraft(base, cookie, ws, "Versionless");
    const noVersion = await patchJson(base, "/api/artifacts/state", cookie, {
      workspaceId: ws,
      artifactId: bare,
      patches: [{ op: "add", path: "x", value: 1 }],
      expectedVersion: 1,
    });
    expect(noVersion.status).toBe(409);
    expect(noVersion.json).toMatchObject({ reason: "no_version_state" });
  });

  it("concurrent first patches converge without 500s", async () => {
    const base = await startApp();
    const cookie = await login(base, "synthetic-artifact-fix-a2");
    const ws = await setupWorkspace(base, cookie, "Race WS");
    const artifactId = await apiCreateDraft(base, cookie, ws, "Racy");
    const v1 = await publish(base, cookie, ws, artifactId, "");
    await activate(base, cookie, ws, artifactId, v1, "");

    // Five concurrent first-inserts: exactly one row can win; losers get a
    // typed 409 (version_mismatch via the 23505 race guard), never a 500.
    // (If the writes serialize, later writers see version 1 and match — also
    // fine; the invariant is no 500 and a coherent final document.)
    const attempts = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        patchJson(base, "/api/artifacts/state", cookie, {
          workspaceId: ws,
          artifactId,
          patches: [{ op: "add", path: `slot${n}`, value: n }],
          expectedVersion: 1,
        }),
      ),
    );
    for (const a of attempts) expect([200, 409]).toContain(a.status);
    expect(attempts.some((a) => a.status === 200)).toBe(true);
    const final = await getJson(base, `/api/artifacts/state?workspaceId=${ws}&artifactId=${artifactId}`, cookie);
    expect(final.status).toBe(200);
    expect(typeof final.json.state).toBe("object");
  });

  it("build rejects foreign artifacts and expanded permissions", async () => {
    const base = await startApp();
    const cookie = await login(base, "synthetic-artifact-fix-b");
    const ws = await setupWorkspace(base, cookie, "Build gate WS");
    const manifest = JSON.parse(VALID.manifest) as Record<string, unknown>;
    const source = { html: VALID.html, css: VALID.css, js: VALID.js };

    const foreign = await postJson(base, "/api/artifacts/build", cookie, {
      workspaceId: ws,
      artifactId: randomUUID(),
      source,
      manifest,
    });
    expect(foreign.status).toBe(404);

    const expanded = await postJson(base, "/api/artifacts/build", cookie, {
      workspaceId: ws,
      artifactId: await apiCreateDraft(base, cookie, ws, "Victim"),
      source,
      manifest: { ...manifest, approvedPermissions: ["balances.read", "transactions.raw.read"] },
    });
    expect(expanded.status).toBe(400);
    expect(expanded.json).toMatchObject({ reason: "invalid_permissions" });

    const ok = await postJson(base, "/api/artifacts/build", cookie, {
      workspaceId: ws,
      artifactId: await apiCreateDraft(base, cookie, ws, "Legit"),
      source,
      manifest,
    });
    expect(ok.status).toBe(201);
    expect(typeof ok.json.versionId).toBe("string");
  });

  it("archived artifacts cannot open sessions or serve RPC", async () => {
    const base = await startApp();
    const cookie = await login(base, "synthetic-artifact-fix-c");
    const ws = await setupWorkspace(base, cookie, "Archive WS");
    const artifactId = await apiCreateDraft(base, cookie, ws, "Archivable");
    const v1 = await publish(base, cookie, ws, artifactId, "");
    await activate(base, cookie, ws, artifactId, v1, "");

    const opened = await postJson(base, "/api/artifacts/sessions", cookie, { workspaceId: ws, artifactId, versionId: v1 });
    expect(opened.status).toBe(201);
    const liveRpc = await postJson(base, "/api/artifacts/sdk/rpc", cookie, { sessionId: opened.json.sessionId, method: "spendingByCategory", args: {} });
    expect(liveRpc.status).toBe(200);

    // Oversized initial state is rejected before a grant exists.
    const fat = await postJson(base, "/api/artifacts/sessions", cookie, {
      workspaceId: ws,
      artifactId,
      versionId: v1,
      initialState: { blob: "x".repeat(70 * 1024) },
    });
    expect(fat.status).toBe(400);

    // Archive directly (no archive UI exists yet; the gate must hold anyway).
    const userId = (await pool.query("SELECT id FROM users WHERE auth_subject = $1", ["synthetic-artifact-fix-c"])).rows[0].id as string;
    await withTenant(pool, { userId, workspaceId: ws }, async (client: PoolClient) => {
      await client.query(`UPDATE artifacts SET archived_at = now() WHERE workspace_id = $1 AND id = $2`, [ws, artifactId]);
    });

    const reopened = await postJson(base, "/api/artifacts/sessions", cookie, { workspaceId: ws, artifactId, versionId: v1 });
    expect(reopened.status).toBe(404);
    const deadRpc = await postJson(base, "/api/artifacts/sdk/rpc", cookie, { sessionId: opened.json.sessionId, method: "spendingByCategory", args: {} });
    expect(deadRpc.status).toBe(404);
  });

  it("server enforces per-session SDK quotas", async () => {
    const base = await startApp();
    const cookie = await login(base, "synthetic-artifact-fix-d");
    const ws = await setupWorkspace(base, cookie, "Quota WS");
    const artifactId = await apiCreateDraft(base, cookie, ws, "Metered");
    const v1 = await publish(base, cookie, ws, artifactId, "");
    await activate(base, cookie, ws, artifactId, v1, "");
    const opened = await postJson(base, "/api/artifacts/sessions", cookie, { workspaceId: ws, artifactId, versionId: v1 });
    expect(opened.status).toBe(201);
    const sessionId = opened.json.sessionId as string;
    const rpc = () => postJson(base, "/api/artifacts/sdk/rpc", cookie, { sessionId, method: "spendingByCategory", args: {} });

    const session = getArtifactSession(sessionId);
    expect(session).toBeTruthy();
    // Exhaust the per-minute window: the next call is refused.
    session!.rpcWindowStart = Date.now();
    session!.rpcWindowCount = 60;
    const capped = await rpc();
    expect(capped.status).toBe(429);
    expect(capped.json).toMatchObject({ error: "rate_limited" });
    // Exhaust outstanding slots: refused while full, served once freed.
    session!.rpcWindowStart = Date.now();
    session!.rpcWindowCount = 0;
    session!.rpcOutstanding = 8;
    const busy = await rpc();
    expect(busy.status).toBe(429);
    session!.rpcOutstanding = 0;
    const served = await rpc();
    expect(served.status).toBe(200);
  });

  it("activate with a bundled migration commits the pair and failed migration rolls back activation", async () => {
    const base = await startApp();
    const cookie = await login(base, "synthetic-artifact-fix-e");
    const ws = await setupWorkspace(base, cookie, "Pair WS");
    const artifactId = await apiCreateDraft(base, cookie, ws, "Paired");
    const v1 = await publish(base, cookie, ws, artifactId, "");
    await activate(base, cookie, ws, artifactId, v1, "");
    const seeded = await patchJson(base, "/api/artifacts/state", cookie, {
      workspaceId: ws,
      artifactId,
      patches: [{ op: "add", path: "months", value: 6 }],
      expectedVersion: 1,
    });
    expect(seeded.status).toBe(200);
    const snap = await postJson(base, `/api/artifacts/${artifactId}/state/snapshots`, cookie, { workspaceId: ws });
    expect(snap.status).toBe(201);

    const v2 = await publish(base, cookie, ws, artifactId, v1, `${VALID.js}\n// v2`);
    // Combined activate + rename-months migration commits atomically.
    const paired = await postJson(base, `/api/artifacts/${artifactId}/activate`, cookie, {
      workspaceId: ws,
      versionId: v2,
      expectedActiveVersionId: v1,
      migration: { fromVersionId: v1, toVersionId: v2, operations: [{ type: "rename", path: "months", newPath: "period" }] },
    });
    expect(paired.status).toBe(200);
    const state = await getJson(base, `/api/artifacts/state?workspaceId=${ws}&artifactId=${artifactId}`, cookie);
    expect(state.status).toBe(200);
    expect(state.json.state).toMatchObject({ period: 6 });

    // A stale v1-era snapshot no longer matches the active v2 code.
    const staleRevert = await postJson(base, `/api/artifacts/${artifactId}/state/revert`, cookie, { workspaceId: ws, snapshotId: snap.json.id });
    expect(staleRevert.status).toBe(409);
    expect(staleRevert.json).toMatchObject({ reason: "incompatible_snapshot" });

    // A failing bundled migration rolls back the activation with it.
    const v3 = await publish(base, cookie, ws, artifactId, v2, `${VALID.js}\n// v3`);
    const failed = await postJson(base, `/api/artifacts/${artifactId}/activate`, cookie, {
      workspaceId: ws,
      versionId: v3,
      expectedActiveVersionId: v2,
      migration: { fromVersionId: v2, toVersionId: v3, operations: [{ type: "rename", path: "nope.missing", newPath: "x" }] },
    });
    expect(failed.status).toBe(409);
    const art = await apiGetArtifact(base, cookie, ws, artifactId);
    expect(art.activeVersionId).toBe(v2);
  });
});
