import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires disposable Supabase auth and applied migration 202610060003");
test("explicit partial/full occurrence association changes the forecast once and retains undo history", async ({ browser }) => {
  test.setTimeout(180_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  let user: string | undefined, workspace: string | undefined;
  const context = await browser.newContext({ baseURL: "http://localhost:3000" });
  const recovery = `.qa/occurrences-${randomUUID()}.json`;
  try {
    expect((await db`select to_regclass('public.recurring_occurrence_settlements') as relation`)[0].relation, "Apply reviewed migration 202610060003 before this acceptance journey").not.toBeNull();
    const email = `qa-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "recurring-occurrences" } });
    expect(created.error).toBeNull(); user = created.data.user!.id;
    [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${user}`;
    mkdirSync(".qa", { recursive: true }); writeFileSync(recovery, JSON.stringify({ project, user, workspace }));
    const account = randomUUID(), assumption = randomUUID(), transaction = randomUUID();
    const now = new Date().toISOString(), today = now.slice(0, 10), label = `Occurrence rent QA ${randomUUID().slice(0, 8)}`;
    await db.begin(async tx => {
      await tx`update public.workspaces set timezone='UTC' where id=${workspace!}`;
      await tx`insert into public.accounts(id,workspace_id,name,currency_code,type) values(${account},${workspace!},'Occurrence cash QA','EUR','checking')`;
      await tx`insert into public.transactions(id,workspace_id,account_id,posted_on,posted_at,description,amount_minor,currency_code,status,kind) values(${transaction},${workspace!},${account},${today},${now},${label},-4000,'EUR','posted','ordinary')`;
      const covered = [{ id: transaction, version: 0, amount_minor: "-4000", currency_code: "EUR", posted_on: today, posted_at: now }];
      await tx`insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind,covered_transactions) values(${workspace!},${account},100000,'EUR',${now},'synthetic reviewed opening','reviewed_activity',${tx.json(covered)})`;
      await tx`insert into public.financial_assumptions(id,workspace_id,account_id,kind,name,amount_minor,currency_code,cadence,starts_on,ends_on,source,confirmed,enabled) values(${assumption},${workspace!},${account},'expense',${label},-10000,'EUR','monthly',${today},${today},'user',true,true)`;
      await tx`insert into public.forecast_preferences(workspace_id,currency_code,uncertainty_bps) values(${workspace!},'EUR',0)`;
    });
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
    const page = await context.newPage();
    const forecast = page.locator("section").filter({ has: page.getByRole("heading", { name: "Liquid balance horizon", exact: true }) });
    await page.goto("/plan"); await expect(forecast).toContainText("EUR 900.00");
    await page.goto("/money/recurring");
    const review = page.getByRole("region", { name: "Occurrence reconciliation" });
    await review.getByLabel("Confirmed assumption", { exact: true }).selectOption(`${assumption}:1`);
    await review.getByLabel("Scheduled occurrence date", { exact: true }).fill(today);
    await review.getByLabel("Transaction", { exact: true }).selectOption(`${transaction}:0`);
    await review.getByLabel("Fulfillment", { exact: true }).selectOption("partial");
    await review.getByRole("button", { name: "Associate occurrence", exact: true }).click();
    await expect(review).toContainText("recorded partial settlement");
    await page.goto("/plan"); await expect(forecast).toContainText("EUR 940.00"); await expect(forecast).not.toContainText("Forecast unavailable");
    await page.goto("/money/recurring"); await review.getByRole("button", { name: "Undo occurrence association", exact: true }).click();
    await expect(review).toContainText("undone");
    await page.goto("/plan"); await expect(forecast).toContainText("EUR 900.00");
    await page.goto("/money/recurring");
    await review.getByLabel("Confirmed assumption", { exact: true }).selectOption(`${assumption}:1`);
    await review.getByLabel("Scheduled occurrence date", { exact: true }).fill(today);
    await review.getByLabel("Transaction", { exact: true }).selectOption(`${transaction}:0`);
    await review.getByLabel("Fulfillment", { exact: true }).selectOption("full");
    await review.getByRole("button", { name: "Associate occurrence", exact: true }).click();
    await expect(review).toContainText("recorded full settlement");
    await page.goto("/plan"); await expect(forecast).toContainText("EUR 1000.00");
    expect((await db`select count(*)::int as count from public.recurring_occurrence_settlements where workspace_id=${workspace!}`)[0].count).toBe(2);
    expect((await db`select amount_minor::text from public.transactions where id=${transaction}`)[0].amount_minor).toBe("-4000");
  } finally {
    await context.close().catch(() => {});
    if (workspace) await db.begin(async tx => {
      for (const table of ["recurring_occurrence_settlements", "planning_events", "financial_assumptions", "transactions", "forecast_preference_events", "forecast_preferences", "balance_snapshots", "accounts"]) await tx`delete from ${tx("public." + table)} where workspace_id=${workspace!}`;
      await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user!}`;
    });
    if (user) { expect((await admin.auth.admin.deleteUser(user)).error).toBeNull(); unlinkSync(recovery); }
    await db.end();
  }
});
