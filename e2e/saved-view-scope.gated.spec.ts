import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires real disposable Supabase authentication");

test("saved transaction view preserves tag and event scope across save, reopen, edit, undo, rename and remove", async ({ browser }) => {
  test.setTimeout(180_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `qa-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "saved-view-scope" } });
  expect(created.error).toBeNull();
  const user = created.data.user!.id;
  const [workspace] = await db`select id from public.workspaces where owner_id=${user}`;
  const recovery = `.qa/saved-view-scope-${user}.json`;
  mkdirSync(".qa", { recursive: true }); writeFileSync(recovery, JSON.stringify({ project, user, workspace: workspace.id }));
  const context = await browser.newContext({ baseURL: "http://localhost:3000" });
  // Synthetic ledger: one tag+event match plus one decoy per nonmatching combination.
  const account = randomUUID(), match = randomUUID(), tagOnly = randomUUID(), eventOnly = randomUUID(), other = randomUUID();
  const matchDesc = "QA Berlin hotel", tagOnlyDesc = "QA Berlin groceries", eventOnlyDesc = "QA Berlin office", otherDesc = "QA Berlin misc";
  try {
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
    await db`insert into public.accounts(id,workspace_id,name,currency_code,type) values(${account},${workspace.id},'QA cash','EUR','checking')`;
    await db`insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,tags,event_name) values
      (${match},${workspace.id},${account},'2026-09-10',${matchDesc},'-2500','EUR',${["holiday"]},'Berlin trip'),
      (${tagOnly},${workspace.id},${account},'2026-09-11',${tagOnlyDesc},'-1200','EUR',${["holiday"]},'Paris weekend'),
      (${eventOnly},${workspace.id},${account},'2026-09-12',${eventOnlyDesc},'-800','EUR',${["work"]},'Berlin trip'),
      (${other},${workspace.id},${account},'2026-09-13',${otherDesc},'-300','EUR',${["work"]},${null})`;
    const page = await context.newPage();
    async function expectScopedView() {
      await expect(page.getByText("1 shown", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: matchDesc })).toBeVisible();
      await expect(page.getByRole("link", { name: tagOnlyDesc })).toHaveCount(0);
      await expect(page.getByRole("link", { name: eventOnlyDesc })).toHaveCount(0);
      await expect(page.getByRole("link", { name: otherDesc })).toHaveCount(0);
    }
    // Live tag+event filter shows only the match, then saving opens an opaque view link.
    await page.goto("/money/transactions?tag=holiday&event=Berlin%20trip");
    await expectScopedView();
    await page.getByLabel("Saved view name").fill("QA Holiday Berlin");
    await page.getByRole("button", { name: "Save view", exact: true }).click();
    await page.waitForURL(/\/money\/transactions\?view=[0-9a-f-]{36}$/);
    const viewUrl = page.url();
    expect(viewUrl).not.toContain("tag=");
    expect(viewUrl).not.toContain("event=");
    await expectScopedView();
    await expect(page.getByLabel("Filter by tag")).toHaveValue("holiday");
    await expect(page.getByLabel("Filter by spending group")).toHaveValue("Berlin trip");
    // Reopening the opaque link reproduces the identical scope.
    await page.goto("/money/transactions");
    await expect(page.getByText("4 shown", { exact: true })).toBeVisible();
    await page.goto(viewUrl);
    await expectScopedView();
    // A persisted but invalid tag scope errors instead of broadening; a legacy row without scope keys loads cleanly.
    const invalidView = randomUUID(), legacyView = randomUUID();
    await db`insert into public.transaction_views(id,workspace_id,name,filters) values
      (${invalidView},${workspace.id},'QA invalid scope',${db.json({ status: "posted", tag: "x".repeat(41) })}),
      (${legacyView},${workspace.id},'QA legacy scope',${db.json({ status: "posted" })})`;
    await page.goto(`/money/transactions?view=${invalidView}`);
    await expect(page.getByText("Saved view has an invalid tag filter", { exact: false })).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByText(/shown/, { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Use current filters" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save view", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Back to normal filters" }).click();
    await page.waitForURL("http://localhost:3000/money/transactions");
    await expect(page.getByText("4 shown", { exact: true })).toBeVisible();
    await page.goto(`/money/transactions?view=${legacyView}`);
    await expect(page.getByText("Saved view has an invalid tag filter", { exact: false })).toHaveCount(0);
    await expect(page.getByText("4 shown", { exact: true })).toBeVisible();
    // Edit a scoped transaction via bulk tags, undo the batch, and confirm the original tag/event scope survives.
    await page.goto(viewUrl);
    await expectScopedView();
    await page.getByText("Bulk categories, tags and spending groups", { exact: true }).click();
    const bulk = page.locator("details").filter({ has: page.getByText("Bulk categories, tags and spending groups", { exact: true }) });
    await bulk.getByLabel(matchDesc, { exact: false }).check();
    await bulk.getByRole("combobox", { name: "Change", exact: true }).selectOption("tags");
    await bulk.getByLabel("Tags, separated by commas").fill("holiday, qa-touched");
    await bulk.getByRole("button", { name: "Preview changes", exact: true }).click();
    await expect(bulk.getByRole("region", { name: "Bulk impact preview" })).toContainText("1 selected transactions");
    await bulk.getByRole("button", { name: "Apply to 1 transactions", exact: true }).click();
    await expect.poll(async () => (await db`select tags from public.transactions where id=${match}`)[0].tags, { timeout: 30_000 }).toEqual(["holiday", "qa-touched"]);
    await page.goto(viewUrl);
    await expectScopedView();
    await page.getByText("Manual entries and batch history", { exact: true }).click();
    await page.getByRole("button", { name: "Undo batch", exact: true }).first().click();
    await expect.poll(async () => (await db`select tags,event_name from public.transactions where id=${match}`)[0], { timeout: 30_000 }).toEqual({ tags: ["holiday"], event_name: "Berlin trip" });
    await page.goto(viewUrl);
    await expectScopedView();
    // Rename then remove the saved view.
    await page.getByLabel("Rename saved view QA Holiday Berlin").fill("QA Holiday Berlin Renamed");
    await page.locator("form", { has: page.getByLabel("Rename saved view QA Holiday Berlin") }).getByRole("button", { name: "Rename", exact: true }).click();
    await page.waitForURL("http://localhost:3000/money/transactions");
    await expect(page.getByRole("link", { name: "QA Holiday Berlin Renamed" })).toBeVisible();
    await page.getByRole("link", { name: "QA Holiday Berlin Renamed" }).click();
    await page.waitForURL(/\/money\/transactions\?view=[0-9a-f-]{36}$/);
    await expect(page).toHaveURL(viewUrl);
    await expect(page.locator("strong").filter({ hasText: /^QA Holiday Berlin Renamed$/ })).toBeVisible();
    await expectScopedView();
    await page.getByRole("button", { name: "Delete saved view QA Holiday Berlin Renamed" }).click();
    await page.waitForURL("http://localhost:3000/money/transactions");
    await expect(page.getByRole("link", { name: "QA Holiday Berlin Renamed" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "QA legacy scope" })).toBeVisible();
  } finally {
    await context.close().catch(() => {});
    await db.begin(async tx => {
      for (const table of ["transaction_batches", "correction_events", "money_metadata_events", "transactions", "transaction_views", "accounts"]) await tx`delete from ${tx("public." + table)} where workspace_id=${workspace.id}`;
      await tx`delete from public.workspaces where id=${workspace.id} and owner_id=${user}`;
    });
    expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
    unlinkSync(recovery); await db.end();
  }
});
