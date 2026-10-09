import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import postgres from "postgres";

test("manifest inputs restore, execute and save under one typed contract", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  for (const name of ["SUPABASE_DB_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]) expect(Boolean(process.env[name]), `Required ${name}`).toBe(true);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `qa-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
  const context = await browser.newContext({ baseURL });
  let user: string | undefined, workspace: string | undefined;
  const recovery = `.qa/manifest-input-${randomUUID()}.json`;
  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "manifest-input-contract" } });
    expect(created.error).toBeNull(); user = created.data.user!.id;
    mkdirSync(".qa", { recursive: true }); writeFileSync(recovery, JSON.stringify({ project, user }));
    const [owned] = await db`select id from public.workspaces where owner_id=${user}`;
    const workspaceId: string = owned.id; workspace = workspaceId; writeFileSync(recovery, JSON.stringify({ project, user, workspace }));
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: new URL(baseURL!).hostname, path: "/", sameSite: "Lax" as const })));
    const page = await context.newPage();
    await page.goto("/ai/library");
    const create = page.locator("form").filter({ has: page.getByLabel("Custom Report", { exact: true }) });
    await create.getByLabel("Custom Report", { exact: true }).fill("Synthetic input contract");
    await create.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForURL(/\/ai\/library\/[0-9a-f-]{36}$/);
    const artifact = page.url().split("/").pop()!;
    const editor = page.getByRole("region", { name: "Edit calculator version" });
    async function reloadArtifact() {
      await page.reload();
      // Dynamic source editor mounts after its parent has hydrated.
      await expect(editor.locator(".cm-content")).toBeVisible();
    }
    const source = 'input => ({ numbers: { amount: input.params.amount, reference: input.params.reference, exactMinor: input.params.exactMinor } })';
    const manifest = { kind: "custom_report", runtime: "quickjs-calculator-v1", sdk: [], params: {
      amount: { type: "number", default: 50, min: 0, max: 100, label: "Amount" },
      reference: { type: "string", default: "00123", maxLength: 8, label: "Reference" },
      exactMinor: { type: "string", default: "9007199254740993", label: "Exact cost" },
    }, renderer: "trusted" };
    await editor.locator(".cm-content").fill(source);
    await editor.getByLabel("Manifest (JSON)").fill(JSON.stringify({ ...manifest, params: { ...manifest.params, amount: { ...manifest.params.amount, max: 1000 } } }));
    await editor.getByRole("button", { name: "Save new version", exact: true }).click();
    const output = page.getByRole("region", { name: "Generated calculator output" });
    await expect(output.locator("dd")).toHaveText(["50", "00123", "9007199254740993"], { timeout: 30_000 });
    await db`update public.artifact_state set state=${db.json({ amount: 500, reference: "00123", exactMinor: "9007199254740993" })} where workspace_id=${workspaceId} and artifact_id=${artifact}`;
    await reloadArtifact();
    await expect(output.locator("dd")).toHaveText(["500", "00123", "9007199254740993"], { timeout: 30_000 });
    await editor.getByLabel("Manifest (JSON)").fill(JSON.stringify(manifest));
    await editor.getByRole("button", { name: "Save new version", exact: true }).click();
    await expect(editor.getByRole("status")).toContainText("validated and activated");
    await expect(output.locator("dd")).toHaveText(["50", "00123", "9007199254740993"], { timeout: 30_000 });
    await expect(output).toContainText("default applies");
    await output.getByLabel("Reference", { exact: true }).fill("00007");
    await output.getByLabel(/Exact cost/).fill("9007199254740995");
    await output.getByLabel("Amount", { exact: true }).fill("100");
    await expect(output.locator("dd")).toHaveText(["100", "00007", "9007199254740995"]);
    await Promise.all([
      page.waitForResponse(response => response.request().method() === "POST" && response.url().includes(`/ai/library/${artifact}`)),
      output.getByRole("button", { name: "Save inputs", exact: true }).click(),
    ]);
    await reloadArtifact();
    await expect(output.getByLabel("Reference", { exact: true })).toHaveValue("00007");
    await expect.poll(async () => (await db`select state from public.artifact_state where workspace_id=${workspaceId} and artifact_id=${artifact}`)[0].state).toEqual({ amount: 100, reference: "00007", exactMinor: "9007199254740995" });
    await output.getByLabel("Amount", { exact: true }).fill("101");
    await expect(output.getByRole("button", { name: "Save inputs", exact: true })).toBeDisabled();
    await expect(output).toContainText(/Param amount/);
    await output.getByLabel("Amount", { exact: true }).fill("0");
    await expect(output.locator("dd")).toHaveText(["0", "00007", "9007199254740995"]);
    // Bypass the control deliberately: Save must reject the same invalid value.
    const [beforeRejected] = await db`select state, version from public.artifact_state where workspace_id=${workspaceId} and artifact_id=${artifact}`;
    await output.locator('input[name="params"]').evaluate(input => { (input as HTMLInputElement).value = JSON.stringify({ amount: 101, reference: "00007", exactMinor: "9007199254740995" }); });
    const [rejected] = await Promise.all([
      page.waitForResponse(response => response.request().method() === "POST" && response.url().includes(`/ai/library/${artifact}`)),
      output.getByRole("button", { name: "Save inputs", exact: true }).click(),
    ]);
    expect(rejected.status()).toBe(200);
    expect(await rejected.text()).not.toContain("Minified React error");
    await expect(output).toContainText(/Param amount/);
    await expect(output).not.toContainText("Inputs saved.");
    await expect(output.getByLabel("Amount", { exact: true })).toHaveValue("0");
    await expect(output.getByLabel("Reference", { exact: true })).toHaveValue("00007");
    await expect(output.getByLabel(/Exact cost/)).toHaveValue("9007199254740995");
    await expect(output.locator('input[name="expectedVersion"]')).toHaveValue(String(beforeRejected.version));
    await expect(output.getByRole("button", { name: "Save inputs", exact: true })).toBeEnabled();
    expect((await db`select state, version from public.artifact_state where workspace_id=${workspaceId} and artifact_id=${artifact}`)[0]).toEqual(beforeRejected);
    await reloadArtifact();
    // Actual version activation rejects invalid defaults.
    await editor.getByLabel("Manifest (JSON)").fill(JSON.stringify({ ...manifest, params: { ...manifest.params, amount: { ...manifest.params.amount, default: 500 } } }));
    await editor.getByRole("button", { name: "Save new version", exact: true }).click();
    await expect(editor.getByRole("status")).toContainText(/recorded as failed.*amount/);
    // A generated trip default survives absent legacy cost state.
    const trip = randomUUID(), version = randomUUID();
    await db`insert into public.artifacts(id,workspace_id,kind,name,permissions) values(${trip},${workspaceId},'trip_planner','Synthetic trip','["balances","goals","forecast"]')`;
    await db`insert into public.artifact_versions(id,workspace_id,artifact_id,version,source,manifest,status) values(${version},${workspaceId},${trip},1,'input => ({numbers:{costMinor:input.params.costMinor}})',${db.json({ kind: "trip_planner", runtime: "quickjs-calculator-v1", sdk: [], params: { costMinor: { type: "number", default: 12000, min: 0, max: 20000 } }, renderer: "trusted" })},'validated')`;
    await db`update public.artifacts set active_version_id=${version} where id=${trip} and workspace_id=${workspaceId}`;
    await db`insert into public.artifact_state(workspace_id,artifact_id,state) values(${workspaceId},${trip},'{}')`;
    await page.goto(`/ai/library/${trip}`);
    await expect(output.locator("dd")).toHaveText("12000", { timeout: 30_000 });
    await expect(output.getByLabel(/costMinor/)).toHaveValue("12000");
    await expect(output).toContainText("EUR");
    await expect(output).toContainText("minor units");
    await db`update public.artifact_state set state=${db.json({ costMinor: 15000 })} where workspace_id=${workspaceId} and artifact_id=${trip}`;
    await reloadArtifact();
    await expect(output.locator("dd")).toHaveText("15000", { timeout: 30_000 });
    await db`update public.artifact_state set state=${db.json({ costMinor: 90000 })} where workspace_id=${workspaceId} and artifact_id=${trip}`;
    await reloadArtifact();
    await expect(output.locator("dd")).toHaveText("12000", { timeout: 30_000 });
    await expect(output).toContainText("default applies");
    // Revoked evidence must not reset compatible inputs to defaults.
    await db`update public.artifacts set permissions='[]' where id=${trip} and workspace_id=${workspaceId}`;
    await db`update public.artifact_state set state=${db.json({ costMinor: 15000 })} where workspace_id=${workspaceId} and artifact_id=${trip}`;
    await reloadArtifact();
    await expect(output.locator("dd")).toHaveText("15000", { timeout: 30_000 });
  } finally {
    await context.close().catch(() => {});
    if (workspace && user) await db.begin(async tx => {
      await tx`update public.artifacts set active_version_id=null where workspace_id=${workspace!}`;
      for (const table of ["artifact_state", "artifact_versions", "artifacts"]) await tx`delete from ${tx("public." + table)} where workspace_id=${workspace!}`;
      await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user!}`;
    });
    if (user) expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
    if (existsSync(recovery)) unlinkSync(recovery);
    await db.end();
  }
});
