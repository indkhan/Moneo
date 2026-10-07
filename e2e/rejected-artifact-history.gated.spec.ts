import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires disposable Supabase authentication and reviewed migration 012");

test("rejected raw manifests persist through authenticated saves without activating or losing retry evidence", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const run = randomUUID(), journal = `.qa/mne032-http-${run}.json`;
  let user: string | undefined, workspace: string | undefined;
  try {
    const applied = await db`select 1 from supabase_migrations.schema_migrations where version='202610060012'`;
    expect(applied.length, "Migration 012 must be deployed; missing acceptance is not a pass").toBe(1);
    const email = `qa-mne032-${run}@example.invalid`, password = randomBytes(24).toString("hex");
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "mne032-http", run_id: run } });
    expect(created.error).toBeNull(); user = created.data.user!.id;
    mkdirSync(".qa", { recursive: true }); writeFileSync(journal, JSON.stringify({ project, user, run }));
    [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${user}`;
    writeFileSync(journal, JSON.stringify({ project, user, workspace, run }));
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: {
      getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
      setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)),
    } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
    const createdArtifact = await auth.rpc("create_trusted_artifact", { p_kind: "custom_comparison", p_name: "Synthetic rejected history QA" });
    expect(createdArtifact.error).toBeNull();
    const artifact = (Array.isArray(createdArtifact.data) ? createdArtifact.data[0] : createdArtifact.data).id;
    const endpoint = `/api/artifacts/${artifact}/versions`;
    const [initial] = await db`select active_version_id from public.artifacts where id=${artifact} and workspace_id=${workspace!}`;
    const state = await db`select state,version from public.artifact_state where artifact_id=${artifact} and workspace_id=${workspace!}`;
    const manifests = [null, ["raw rejected array"], "raw rejected scalar", { kind: "custom_comparison", runtime: "quickjs-calculator-v1", sdk: ["denied-operation"], params: {}, renderer: "trusted" }];
    const failures: string[] = [];
    for (const [index, manifest] of manifests.entries()) {
      const source = `(input) => ({summary: "Synthetic rejected attempt ${index}"})`;
      const response = await context.request.post(endpoint, { data: { source, manifest, expectedActiveVersionId: initial.active_version_id } });
      expect(response.status(), "Actual authenticated HTTP save must retain a failed history row").toBe(200);
      const saved = await response.json();
      expect(saved.status).toBe("failed"); expect(saved.validation.ok).toBe(false);
      expect(saved.version.manifest).toEqual(manifest); expect(saved.version.source).toBe(source);
      expect(saved.version.version).toBe(index + 2); expect(saved.version.error.length).toBeGreaterThan(0);
      failures.push(saved.version.id);
    }
    const history = await context.request.get(endpoint); expect(history.ok()).toBe(true);
    const savedHistory = await history.json(); expect(savedHistory.activeVersionId).toBe(initial.active_version_id);
    expect(savedHistory.versions).toHaveLength(5);
    for (const [index, id] of failures.entries()) expect(savedHistory.versions.find((row: { id: string }) => row.id === id).manifest).toEqual(manifests[index]);
    const spoof = await context.request.post(endpoint, { data: { source: "input => ({})", manifest: null, status: "validated", expectedActiveVersionId: initial.active_version_id } });
    expect(spoof.status()).toBe(400);
    const restore = await context.request.post(endpoint, { data: { restoreTrustedVersionId: failures[0], expectedActiveVersionId: initial.active_version_id } });
    expect(restore.ok()).toBe(false);
    const page = await context.newPage(); await page.goto(`/ai/library/${artifact}`);
    const editor = page.getByRole("region", { name: "Edit calculator version" });
    const failed = editor.getByRole("listitem").filter({ hasText: /v2.*failed/ });
    await expect(failed).toBeVisible({ timeout: 30_000 });
    await failed.getByText("Manifest", { exact: true }).click();
    await expect(failed.locator("pre").last()).toHaveText("null");
    await expect(failed.getByRole("button", { name: /Restore/ })).toHaveCount(0);
    await failed.getByRole("button", { name: "Retry this version (load into editor)", exact: true }).click();
    await expect(editor.getByRole("textbox", { name: "Manifest (JSON)", exact: true })).toHaveValue("null");
    await expect(editor.getByRole("textbox", { name: "Calculator source", exact: true })).toContainText("Synthetic rejected attempt 0");
    expect((await db`select active_version_id from public.artifacts where id=${artifact} and workspace_id=${workspace!}`)[0]).toEqual(initial);
    expect(await db`select state,version from public.artifact_state where artifact_id=${artifact} and workspace_id=${workspace!}`).toEqual(state);
    expect((await db`select count(*)::int count from public.artifact_versions where artifact_id=${artifact} and workspace_id=${workspace!}`)[0].count).toBe(5);
  } finally {
    await context.close().catch(() => {});
    try {
      if (workspace && user) await db.begin(async tx => {
        expect((await tx`select owner_id from public.workspaces where id=${workspace!}`)[0].owner_id).toBe(user);
        await tx`update public.artifacts set active_version_id=null where workspace_id=${workspace!}`;
        for (const table of ["artifact_state", "dashboard_items", "artifact_versions", "artifacts"]) await tx`delete from ${tx("public." + table)} where workspace_id=${workspace!}`;
        await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user!}`;
      });
      if (user) expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
      if (workspace) expect((await db`select count(*)::int count from public.workspaces where id=${workspace}`)[0].count).toBe(0);
      if (user) {
        expect((await db`select count(*)::int count from auth.users where id=${user}`)[0].count).toBe(0);
        writeFileSync(`.qa/mne032-http-cleanup-${run}.json`, JSON.stringify({ cleaned: true, workspaceRemaining: 0, authUserRemaining: 0 }));
        unlinkSync(journal);
      }
    } finally { await db.end(); }
  }
});
