import { test, expect, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import postgres from "postgres";

test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_DB_URL || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires disposable Supabase auth/database fixtures");

test("exports remain paired with completed inputs before debounce, on rerun, failure and Stop", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, project = new URL(url).hostname.split(".")[0];
  const connection = new URL(process.env.SUPABASE_DB_URL!);
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBeTruthy();
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const runId = randomUUID(), journal = `.qa/artifact-export-${runId}.json`;
  let user: string | undefined, workspace: string | undefined, context: BrowserContext | undefined;
  mkdirSync(".qa", { recursive: true });
  writeFileSync(journal, JSON.stringify({ project, runId, status: "before-create" }));
  const ledgerBefore = await db`select version from supabase_migrations.schema_migrations order by version`;
  try {
    const email = `qa-export-${runId}@example.invalid`, password = randomBytes(24).toString("hex");
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "artifact-export", run_id: runId } });
    expect(created.error).toBeNull(); user = created.data.user!.id;
    [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${user}`;
    writeFileSync(journal, JSON.stringify({ project, user, workspace, status: "created" }));
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: {
      getAll: () => [...cookies].map(([name,value]) => ({name,value})), setAll: values => { for (const value of values) cookies.set(value.name,value.value); },
    } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    context = await browser.newContext({ baseURL });
    await context.addCookies([...cookies].map(([name,value]) => ({ name,value,domain: new URL(baseURL!).hostname,path: "/",sameSite: "Lax" as const })));
    const page = await context.newPage();
    const [{ id }] = await db.begin(async tx => {
      await tx`select set_config('request.jwt.claim.sub',${user!},true)`;
      await tx.unsafe("set local role authenticated");
      return tx`select (public.create_trusted_artifact('custom_comparison',${`Synthetic export ${runId}`})).id`;
    });
    await page.goto(`/ai/library/${id}`);
    const versions = await (await page.request.get(`/api/artifacts/${id}/versions`)).json();
    const saved = await page.request.post(`/api/artifacts/${id}/versions`, { data: {
      source: 'input => { if(input.params.size === 999) throw new Error("Synthetic failure"); return {summary: "Calculated size " + input.params.size}; }',
      expectedActiveVersionId: versions.activeVersionId,
      manifest: {kind: "custom_comparison",runtime: "quickjs-calculator-v1",sdk: [],params: {size: {type: "number",min: 0,max: 1000,default: 100}, month: {type: "string",default: "2026-09",maxLength: 7}},renderer: "trusted"},
    } });
    expect(saved.ok(), await saved.text()).toBe(true);
    await page.reload();
    const panel = page.getByRole("region", {name: "Generated calculator output"});
    const input = panel.getByLabel("size", {exact: true});
    const print = panel.getByRole("button", {name: "Print / PDF",exact: true});
    const png = panel.getByRole("button", {name: "Export PNG",exact: true});
    await expect(panel.getByText("Calculated size 100", {exact: true})).toBeVisible();
    await expect(print).toBeEnabled();
    // Freeze the real browser clock after completion: React input changes render,
    // but the 300 ms execution callback cannot run and hide the export race.
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await input.fill("200");
    expect(await print.isEnabled(), "Export must be invalidated before debounce expires").toBe(false);
    expect(await png.isEnabled()).toBe(false);
    await page.clock.runFor(400);
    await expect(panel.getByText("Calculated size 200", {exact: true})).toBeVisible();
    await expect(print).toBeEnabled();
    await panel.getByRole("button", {name: "Re-run",exact: true}).click();
    expect(await print.isEnabled()).toBe(false);
    await panel.getByRole("button", {name: "Stop",exact: true}).click();
    await page.clock.runFor(400);
    await expect(print).toBeDisabled();
    await input.fill("999"); await page.clock.runFor(400);
    await expect(panel).toContainText("Synthetic failure");
    await expect(print).toBeDisabled();
    await input.fill("300"); await page.clock.runFor(400);
    await expect(panel.getByText("Calculated size 300", {exact: true})).toBeVisible();
    await expect(print).toBeEnabled();
    // A server refresh delivers a replacement evidence object while keeping
    // this edited draft. Freeze the debounce to test that dependency race too.
    const refreshed = page.waitForResponse(response => response.request().method() === "GET" && response.url().includes(`/ai/library/${id}`));
    await panel.getByRole("button", {name: "Check saved inputs", exact: true}).click();
    await refreshed;
    await expect(print).toBeDisabled();
    await page.clock.runFor(400);
    await expect(panel.getByText("Calculated size 300", {exact: true})).toBeVisible();
    await expect(print).toBeEnabled();
    await panel.getByLabel("month", {exact: true}).fill("2026-08");
    expect(await print.isEnabled()).toBe(false);
    await page.clock.runFor(400);
    await expect(panel).toContainText("Save inputs to load financial evidence for the selected month.");
    await expect(print).toBeDisabled();
    await panel.getByLabel("month", {exact: true}).fill("2026-09");
    await page.clock.runFor(400);
    await expect(panel.getByText("Calculated size 300", {exact: true})).toBeVisible();
    await expect(print).toBeEnabled();
    // Suppress the native dialog, keeping the actual printable iframe for inspection.
    await page.evaluate(() => {
      const append = document.body.append.bind(document.body);
      document.body.append = (...nodes) => { append(...nodes); for (const node of nodes) if (node instanceof HTMLIFrameElement && node.contentWindow) node.contentWindow.print = () => {}; };
    });
    await print.click();
    const text = await page.locator('iframe[title="Printable calculator report"]').contentFrame().locator('pre').innerText();
    expect(text).toContain('"size": 300'); expect(text).toContain('Calculated size 300');
    expect(text).toContain(`Artifact: ${id}`); expect(text).toContain('v2'); expect(text).toContain('Exact evidence appendix');
    expect(text).toContain('Completed '); expect(text).toContain('Evidence revision:');
  } finally {
    await context?.close().catch(() => {});
    if (workspace) await db.begin(async tx => {
      expect((await tx`select owner_id from public.workspaces where id=${workspace!}`)[0]?.owner_id).toBe(user);
      await tx`delete from public.dashboard_items where workspace_id=${workspace!}`;
      await tx`update public.artifacts set active_version_id=null where workspace_id=${workspace!}`;
      await tx`delete from public.artifact_state where workspace_id=${workspace!}`;
      await tx`delete from public.artifact_versions where workspace_id=${workspace!}`;
      await tx`delete from public.artifacts where workspace_id=${workspace!}`;
      await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user!}`;
    });
    if (user) { expect((await admin.auth.admin.deleteUser(user)).error).toBeNull(); expect((await db`select id from auth.users where id=${user}`).length).toBe(0); }
    expect(await db`select version from supabase_migrations.schema_migrations order by version`).toEqual(ledgerBefore);
    writeFileSync(journal, JSON.stringify({ project, user, workspace, status: "cleaned", migrationLedgerUnchanged: true }));
    await db.end();
  }
});
