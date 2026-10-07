import { test, expect, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import postgres from "postgres";

test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_DB_URL || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires disposable Supabase auth/database fixtures");

test("two tabs preserve edited calculator and trip state revisions across refresh and conflict recovery", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, project = new URL(url).hostname.split(".")[0];
  const connection = new URL(process.env.SUPABASE_DB_URL!);
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBeTruthy();
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const runId = randomUUID(), journal = `.qa/artifact-state-${runId}.json`;
  let user: string | undefined, workspace: string | undefined, context: BrowserContext | undefined;
  mkdirSync(".qa", { recursive: true });
  writeFileSync(journal, JSON.stringify({ project, runId, status: "before-create" }));
  const ledgerBefore = await db`select version from supabase_migrations.schema_migrations order by version`;
  try {
    const email = `qa-state-${runId}@example.invalid`, password = randomBytes(24).toString("hex");
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "artifact-state", run_id: runId } });
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
    const page = await context.newPage(), tab = await context.newPage();
    for (const kind of ["custom_comparison", "trip_planner"] as const) {
      const [{ id }] = await db.begin(async tx => {
        await tx`select set_config('request.jwt.claim.sub',${user!},true)`;
        await tx.unsafe("set local role authenticated");
        return tx`select (public.create_trusted_artifact(${kind},${`Synthetic state ${runId}`})).id`;
      });
      const path = `/ai/library/${id}`;
      await page.goto(path);
      if (kind === "custom_comparison") {
        const versions = await (await page.request.get(`/api/artifacts/${id}/versions`)).json();
        const response = await page.request.post(`/api/artifacts/${id}/versions`, { data: {
          source: "input => ({ summary: String(input.params.size) })", expectedActiveVersionId: versions.activeVersionId,
          manifest: { kind, runtime: "quickjs-calculator-v1", sdk: [], params: { size: { type: "number", min: 0, max: 1000, default: 100 } }, renderer: "trusted" },
        } });
        expect(response.ok(), await response.text()).toBe(true);
        await page.reload();
      }
      await tab.goto(path);
      const before = (await db`select permissions,active_version_id from public.artifacts where id=${id}`)[0];
      const history = await db`select id,source,manifest from public.artifact_versions where artifact_id=${id} order by version`;
      const region = (target: typeof page) => kind === "custom_comparison" ? target.getByRole("region", { name: "Generated calculator output" }) : target.locator("section").filter({ has: target.getByRole("heading", { name: "Trip cost", exact: true }) });
      const input = (target: typeof page) => region(target).getByLabel(kind === "custom_comparison" ? "size" : /Cost in minor units/);
      const save = (target: typeof page) => region(target).getByRole("button", { name: kind === "custom_comparison" ? "Save inputs" : "Save and recalculate", exact: true });
      const read = async () => (await db`select state,version from public.artifact_state where artifact_id=${id}`)[0];
      const initial = await read();
      await input(page).fill("300"); await input(tab).fill("200"); await save(tab).click();
      await expect(region(tab)).toContainText("Inputs saved.", { timeout: 20_000 });
      await expect.poll(async () => (await read()).version).toBe(initial.version + 1);
      // The stale submit must conflict even before this tab has fetched the newer state.
      await save(page).click();
      await expect(region(page).getByRole("alert").filter({ hasText: "Saved inputs changed" })).toContainText("draft is preserved", { timeout: 20_000 });
      await expect(input(page)).toHaveValue("300");
      await expect(region(page).locator('input[name="expectedVersion"]')).toHaveValue(String(initial.version));
      expect((await read()).state[kind === "custom_comparison" ? "size" : "costMinor"]).toBe(200);
      await expect(region(page)).toContainText("200");
      await region(page).getByRole("button", { name: "Keep my draft against latest inputs", exact: true }).click();
      await save(page).click();
      await expect(region(page)).toContainText("Inputs saved.", { timeout: 20_000 });
      await expect.poll(async () => (await read()).version).toBe(initial.version + 2);
      expect((await read()).state[kind === "custom_comparison" ? "size" : "costMinor"]).toBe(300);
      await tab.reload();
      await input(page).fill("500"); await input(tab).fill("400"); await save(tab).click();
      await expect(region(tab)).toContainText("Inputs saved.", { timeout: 20_000 });
      await expect.poll(async () => (await read()).version).toBe(initial.version + 3);
      // Refresh server evidence while preserving the draft's original comparison revision.
      await region(page).getByRole("button", { name: "Check saved inputs", exact: true }).click();
      await expect(region(page).getByRole("alert").filter({ hasText: "Saved inputs changed" })).toContainText("draft is preserved", { timeout: 20_000 });
      await expect(input(page)).toHaveValue("500");
      await expect(region(page).locator('input[name="expectedVersion"]')).toHaveValue(String(initial.version + 2));
      await region(page).getByRole("button", { name: "Reload saved inputs", exact: true }).click();
      await expect(input(page)).toHaveValue("400");
      expect((await read()).version).toBe(initial.version + 3);
      expect((await db`select permissions,active_version_id from public.artifacts where id=${id}`)[0]).toEqual(before);
      expect(await db`select id,source,manifest from public.artifact_versions where artifact_id=${id} order by version`).toEqual(history);
    }
  } finally {
    await context?.close();
    if (workspace) await db.begin(async tx => {
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
