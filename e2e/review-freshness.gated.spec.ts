import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";
import { loadFinancialReviewEvidence } from "../lib/finance/review-loader";
import { settingsSchema } from "../lib/settings";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires real disposable Supabase authentication");

test("saved review stays historical while balance corrections and scopes change its freshness", async ({ browser }) => {
  test.setTimeout(120_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `qa-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "review-freshness" } });
  expect(created.error).toBeNull();
  const user = created.data.user!.id;
  const [workspace] = await db`select id,display_currency,'Europe/Berlin' as timezone from public.workspaces where owner_id=${user}`;
  const recovery = `.qa/review-freshness-${user}.json`;
  mkdirSync(".qa", { recursive: true }); writeFileSync(recovery, JSON.stringify({ project, user, workspace: workspace.id }));
  const context = await browser.newContext({ baseURL: "http://localhost:3000" });
  try {
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
    const account = randomUUID(), job = randomUUID();
    await db`insert into public.workspace_settings(workspace_id,locale) values(${workspace.id},'de-DE')`;
    await db`insert into public.accounts(id,workspace_id,name,currency_code,type) values(${account},${workspace.id},'Review cash','EUR','checking')`;
    const initialDate = new Date(Date.now() - 60_000).toISOString(), correctedDate = new Date(Date.now() - 30_000).toISOString();
    await db`insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance) values(${workspace.id},${account},100000,'EUR',${initialDate},'manual')`;
    const evidence = await loadFinancialReviewEvidence(admin, workspace as { id: string; display_currency: string; timezone: string }, settingsSchema.parse({}));
    expect(evidence.accounts[0].balanceMinor).toBe("100000");
    expect((await loadFinancialReviewEvidence(auth, workspace as { id: string; display_currency: string; timezone: string }, settingsSchema.parse({}))).accounts[0].balanceMinor).toBe("100000");
    const body = "Historical fixture: EUR 1000.00 recorded cash. " + "Saved evidence remains unchanged. ".repeat(150);
    await db`insert into public.background_jobs(id,workspace_id,kind,status,stage) values(${job},${workspace.id},'financial_review','completed','completed')`;
    await db`insert into public.saved_analyses(workspace_id,job_id,title,body,evidence) values(${workspace.id},${job},'Historical review',${body},${db.json(JSON.parse(JSON.stringify(evidence)))})`;
    const page = await context.newPage();
    async function status() { const result = await context.request.get(`/api/analysis/${job}`); expect(result.ok()).toBe(true); return (await result.json()).analysis.freshness.status; }
    expect(await status()).toBe("current");
    await page.goto(`/ai/activity/${job}`);
    const [{ created_at: savedAt }] = await db`select created_at from public.saved_analyses where job_id=${job}`;
    await expect(page.getByText(`Saved ${new Date(savedAt).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}`, { exact: false })).toBeVisible();
    await expect(page.getByText(/Evidence current:/)).toBeVisible();
    await expect(page.locator("article")).toContainText(body);
    await page.goto("/ai/library");
    const create = page.locator("form").filter({ has: page.getByLabel("Custom Comparison", { exact: true }) });
    await create.getByLabel("Custom Comparison", { exact: true }).fill("Live cash evidence");
    await create.getByRole("button", { name: "Create", exact: true }).click();
    await page.waitForURL(/\/ai\/library\/[0-9a-f-]{36}$/);
    const toolUrl = page.url();
    const editor = page.getByRole("region", { name: "Edit calculator version" });
    await editor.locator(".cm-content").fill('input => { const cash = input.snapshot.balances?.[0]?.balance?.amount_minor; return cash ? { numbers: { cashMinor: cash } } : { unavailable: input.snapshot.unavailable || "No dated balance" }; }');
    await editor.getByLabel("Manifest (JSON)").fill(JSON.stringify({ kind: "custom_comparison", runtime: "quickjs-calculator-v1", sdk: ["balances"], params: {}, renderer: "trusted" }));
    await editor.getByRole("button", { name: "Save new version", exact: true }).click();
    const output = page.getByRole("region", { name: "Generated calculator output" });
    await expect(output.locator("dd")).toHaveText("100000", { timeout: 20_000 });
    await db`insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance) values(${workspace.id},${account},90000,'EUR',${correctedDate},'manual')`;
    expect(await status()).toBe("stale");
    await page.goto(toolUrl);
    await expect(output.locator("dd")).toHaveText("90000", { timeout: 20_000 });
    await page.goto(`/ai/activity/${job}`);
    await expect(page.getByText(/Evidence stale:/)).toBeVisible();
    await expect(page.locator("article")).toContainText(body);
    await db`insert into public.workspace_settings(workspace_id,ai_data_scopes) values(${workspace.id},'{}') on conflict(workspace_id) do update set ai_data_scopes='{}'`;
    expect(await status()).toBe("unknown");
    await page.goto(toolUrl);
    await expect(output).toContainText("AI access to accounts is disabled in Settings", { timeout: 20_000 });
    await expect(output.locator("dd")).toHaveCount(0);
    expect((await db`select body,evidence from public.saved_analyses where job_id=${job}`)[0]).toEqual({ body, evidence });
  } finally {
    await context.close().catch(() => {});
    await db.begin(async tx => {
      await tx`update public.artifacts set active_version_id=null where workspace_id=${workspace.id}`;
      for (const table of ["artifact_state", "artifact_versions", "artifacts", "saved_analyses", "background_jobs", "balance_snapshots", "accounts"]) await tx`delete from ${tx("public." + table)} where workspace_id=${workspace.id}`;
      await tx`delete from public.workspaces where id=${workspace.id} and owner_id=${user}`;
    });
    expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
    unlinkSync(recovery); await db.end();
  }
});
