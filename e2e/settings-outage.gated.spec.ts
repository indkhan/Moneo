import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires real disposable Supabase authentication");

test("settings save revocation and display changes with an unchanged unavailable model", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `qa-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "settings-outage" } });
  expect(created.error).toBeNull();
  const user = created.data.user!.id;
  const [workspace] = await db`select id,display_currency from public.workspaces where owner_id=${user}`;
  const recovery = `.qa/settings-outage-${user}.json`;
  mkdirSync(".qa", { recursive: true }); writeFileSync(recovery, JSON.stringify({ project, user, workspace: workspace.id }));
  const origin = new URL(baseURL ?? "http://localhost:3000").origin;
  const host = new URL(baseURL ?? "http://localhost:3000").hostname;
  const settingsUrl = new URL("/settings", origin).toString();
  const context = await browser.newContext();
  try {
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: host, path: "/", sameSite: "Lax" as const })));
    const syntheticModel = "synthetic/mne-023-unavailable";
    await db`insert into public.workspace_settings(workspace_id,openrouter_model,ai_data_scopes,summary_cadence) values(${workspace.id},${syntheticModel},array['accounts','transactions','planning','imports']::text[],'weekly')`;
    const page = await context.newPage();
    await page.goto(settingsUrl);
    await expect(page.getByLabel("Free OpenRouter model")).toHaveValue(syntheticModel);
    await expect(page.locator('select[name="openrouter_model"]')).toContainText(`${syntheticModel} · verification unavailable`);
    await page.locator('input[name="ai_data_scopes"]').evaluateAll(inputs => inputs.forEach(input => { if ((input as HTMLInputElement).checked) (input as HTMLInputElement).click(); }));
    await expect(page.locator('input[name="ai_data_scopes"]:checked')).toHaveCount(0);
    await page.getByLabel("In-app summary preference").selectOption("none");
    await page.getByLabel("Appearance").selectOption("light");
    await page.getByLabel("Display currency").fill("USD");
    await page.getByRole("button", { name: "Save preferences", exact: true }).click();
    await expect(page.getByText("Preferences saved.")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("form").getByRole("alert")).toHaveCount(0);
    const [saved] = await db`select openrouter_model,ai_data_scopes,summary_cadence,theme from public.workspace_settings where workspace_id=${workspace.id}`;
    expect(saved).toEqual({ openrouter_model: syntheticModel, ai_data_scopes: [], summary_cadence: "none", theme: "light" });
    const [renamed] = await db`select display_currency from public.workspaces where id=${workspace.id}`;
    expect(renamed).toEqual({ display_currency: "USD" });
    await page.goto(settingsUrl);
    await expect(page.locator('input[name="ai_data_scopes"]:checked')).toHaveCount(0);
    await expect(page.getByText("Preferences saved.")).toHaveCount(0);
  } finally {
    await context.close().catch(() => {});
    await db.begin(async tx => {
      await tx`delete from public.workspace_settings where workspace_id=${workspace.id}`;
      await tx`delete from public.workspaces where id=${workspace.id} and owner_id=${user}`;
    });
    expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
    unlinkSync(recovery); await db.end();
  }
});
