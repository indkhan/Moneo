import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires real disposable Supabase authentication and database fixtures");

test("scenario comparison, edits, removal and undo preserve actual cash", async ({ browser }) => {
  test.setTimeout(120_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `qa-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "scenario-history" } });
  expect(created.error).toBeNull();
  const user = created.data.user!.id;
  const [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${user}`;
  const recovery = `.qa/scenario-${user}.json`;
  mkdirSync(".qa", { recursive: true }); writeFileSync(recovery, JSON.stringify({ project, user, workspace }));
  const context = await browser.newContext({ baseURL: "http://localhost:3000" });
  try {
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
    const account = randomUUID();
    await db`insert into public.accounts(id,workspace_id,name,currency_code,type) values(${account},${workspace},'Scenario cash','EUR','checking')`;
    await db`insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance) values(${workspace},${account},100000,'EUR',now(),'manual')`;
    await db`insert into public.forecast_preferences(workspace_id,currency_code,uncertainty_bps) values(${workspace},'EUR',0)`;
    const page = await context.newPage();
    await page.goto("/plan");
    await page.getByLabel("New scenario name", { exact: true }).fill("Laptop decision");
    await page.getByRole("button", { name: "Create scenario", exact: true }).click();
    await expect(page).toHaveURL(/scenario=/);
    const scenario = new URL(page.url()).searchParams.get("scenario")!;
    await page.getByLabel("Hypothetical event name", { exact: true }).fill("Laptop");
    await page.getByLabel("Hypothetical change amount", { exact: true }).fill("-200.00");
    const add = page.locator("form").filter({ has: page.getByRole("button", { name: "Add hypothetical change", exact: true }) });
    await add.getByRole("combobox", { name: "Account", exact: true }).selectOption(account);
    await add.getByRole("button", { name: "Add hypothetical change", exact: true }).click();
    // Independently known cash1000 minus a single200 hypothetical event, zero uncertainty/buffer.
    await expect(page.locator("body")).toContainText("Compared with the real plan: -EUR 200.00 change", { timeout: 30_000 });
    await page.getByText("Edit scenario event", { exact: true }).click();
    await page.getByLabel("Change (EUR)", { exact: true }).fill("-300.00");
    await page.getByRole("button", { name: "Save scenario event", exact: true }).click();
    await expect(page.locator("body")).toContainText("Compared with the real plan: -EUR 300.00 change", { timeout: 30_000 });
    await page.getByRole("button", { name: "Remove scenario event", exact: true }).click();
    await expect(page.locator("body")).toContainText("Compared with the real plan: EUR 0.00 change", { timeout: 30_000 });
    const [{ id: event }] = await db`select id from public.scenario_events where workspace_id=${workspace} and entity_type='override' and undone=false order by created_at desc limit 1`;
    await page.getByText("Scenario history and undo", { exact: true }).click();
    await page.locator("form").filter({ has: page.locator(`input[name="eventId"][value="${event}"]`) }).getByRole("button", { name: "Undo scenario change", exact: true }).click();
    await expect.poll(async () => (await db`select removed_at from public.scenario_overrides where scenario_id=${scenario}`)[0].removed_at).toBeNull();
    await page.goto(`/plan?scenario=${scenario}`);
    await expect(page.locator("body")).toContainText("Compared with the real plan: -EUR 300.00 change");
    await page.getByText("Edit Laptop decision", { exact: true }).click();
    await page.getByLabel("Scenario name", { exact: true }).fill("Reviewed decision");
    await page.getByRole("button", { name: "Save scenario", exact: true }).click();
    await expect(page.getByRole("link", { name: "Reviewed decision", exact: true })).toBeVisible();
    expect((await db`select amount_minor::text from public.balance_snapshots where workspace_id=${workspace}`)[0].amount_minor).toBe("100000");
    expect((await db`select count(*)::int as count from public.transactions where workspace_id=${workspace}`)[0].count).toBe(0);
    expect((await db`select count(*)::int as count from public.goal_allocations where workspace_id=${workspace}`)[0].count).toBe(0);
  } finally {
    await context.close().catch(() => {});
    await db.begin(async tx => {
      for (const table of ["scenario_events", "scenario_overrides", "scenarios", "forecast_preference_events", "forecast_preferences", "balance_snapshots", "accounts"]) await tx`delete from ${tx("public." + table)} where workspace_id=${workspace}`;
      await tx`delete from public.workspaces where id=${workspace} and owner_id=${user}`;
    });
    expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
    unlinkSync(recovery); await db.end();
  }
});
