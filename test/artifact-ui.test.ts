// E05-S05 manual editor: server-rendered list/detail with Preview/Code/
// Data/Activity/Versions tabs, native forms for create/publish/activate,
// compact/full sandbox preview pages. Real PG (own `moneo_e05_artifact_ui`
// DB), stub issuer for auth. Synthetic artifact source only.

import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createApp } from "../apps/web/src/server.ts";
import { createAuthRouter, requestSession, type AuthConfig } from "../apps/web/src/auth.ts";
import type { Session } from "../apps/web/src/session-store.ts";
import { createTenancyRouter } from "../apps/web/src/tenancy.ts";
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
