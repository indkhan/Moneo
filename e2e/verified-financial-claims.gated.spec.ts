import { expect, test, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";
import { loadInvestigationDataset } from "../lib/finance/investigation-reader";
import { investigationReceipt } from "../lib/finance/investigation-receipt";
import { persistEvidenceReceipt } from "../lib/finance/evidence-receipts";
import { providerFinancialAnswer } from "../lib/finance/tool-evidence";
import { settingsSchema } from "../lib/settings";
import type { requireWorkspace } from "../lib/auth";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires disposable Supabase authentication and deployed migration014; no provider is used");
test("owned exact claims open retained support, source corrections mark stale, foreign/revoked access fails and legacy history remains", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1, onnotice: () => {} });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const contexts: BrowserContext[] = [], users: string[] = [], workspaces: string[] = [];
  const recovery = `.qa/verified-claims-${randomUUID()}.json`;
  mkdirSync(".qa", { recursive: true });
  try {
    expect((await db`select to_regclass('public.financial_evidence_receipts') as relation`)[0].relation, "Root must deploy reviewed migration014 before this browser gate").not.toBeNull();
    for (let index = 0; index < 2; index++) {
      const email = `qa-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "verified-claims" } });
      expect(created.error).toBeNull(); users.push(created.data.user!.id);
      const [{ id }] = await db`select id from public.workspaces where owner_id=${users[index]}`;
      workspaces.push(id); writeFileSync(recovery, JSON.stringify({ project, users, workspaces }));
      const cookies = new Map<string, string>();
      const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)) } });
      expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
      const context = await browser.newContext({ baseURL }); contexts.push(context);
      await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
    }
    const workspaceId = workspaces[0], account = randomUUID(), transaction = randomUUID(), job = randomUUID();
    await db`insert into public.accounts(id,workspace_id,name,currency_code,type) values(${account},${workspaceId},'Synthetic evidence account','EUR','checking')`;
    await db`insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code) values(${transaction},${workspaceId},${account},'2026-09-01','Synthetic retained posting',-9007199254740993,'EUR')`;
    const context = { supabase: admin, workspace: { id: workspaceId, timezone: "UTC", display_currency: "EUR" }, settings: settingsSchema.parse({}) } as Awaited<ReturnType<typeof requireWorkspace>>;
    const dataset = await loadInvestigationDataset({ version: 1, period: { from: "2026-09-01", to: "2026-09-30" }, metric: "spending" }, context, { canReadImports: true });
    const receipt = await persistEvidenceReceipt(admin, investigationReceipt(dataset, ["accounts", "transactions", "imports"]));
    const metric = receipt.metrics[0];
    const body = providerFinancialAnswer(JSON.stringify({ claims: [{ operation: "metric", operands: [{ receiptId: receipt.id, metricId: metric.id }], valueMinor: metric.valueMinor, currency: metric.currency, periods: [metric.period], qualifiers: metric.qualifiers }], interpretation: [] }), [receipt], workspaceId).body;
    expect(body).toContain("EUR 90071992547409.93");
    await db`insert into public.background_jobs(id,workspace_id,kind,status,stage) values(${job},${workspaceId},'financial_review','completed','completed')`;
    const original = "Historical provider claim: EUR 999999.00. Original history preserved.";
    await db`insert into public.saved_analyses(workspace_id,job_id,title,body,evidence) values(${workspaceId},${job},'Original historical review',${original},${db.json({ period: dataset.spec.period })})`;
    const page = await contexts[0].newPage();
    const metricPath = `/ai/evidence/${receipt.id}?metric=${encodeURIComponent(metric.id)}`;
    await page.goto(metricPath);
    await expect(page.getByText("EUR 90071992547409.93", { exact: true })).toBeVisible();
    await expect(page.getByText("Evidence current", { exact: true })).toBeVisible();
    await expect(page.getByText(/Partial coverage:/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Actual calculation" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open supporting record", exact: true })).toHaveAttribute("href", `/money/transactions?transaction=${transaction}`);
    const owned = await contexts[0].request.get(`/api/evidence/${receipt.id}?metric=${encodeURIComponent(metric.id)}`);
    expect(owned.ok()).toBe(true); expect((await owned.json()).supportingRecords[0].record.amountMinor).toBe("-9007199254740993");
    expect((await contexts[1].request.get(`/api/evidence/${receipt.id}`)).status()).toBe(404);
    expect((await contexts[0].request.get(`/api/evidence/${receipt.id}?metric=nonexistent`)).status()).toBe(404);
    await db`update public.transactions set amount_minor=-25,version=version+1 where id=${transaction} and workspace_id=${workspaceId}`;
    await page.reload();
    await expect(page.getByText("Evidence stale", { exact: true })).toBeVisible();
    await expect(page.getByText("EUR 90071992547409.93", { exact: true })).toBeVisible();
    expect((await db`select receipt from public.financial_evidence_receipts where id=${receipt.id}`)[0].receipt).toEqual(receipt);
    await page.goto(`/ai/activity/${job}`);
    await expect(page.getByText(/Unverified historical review:/)).toBeVisible();
    await expect(page.locator("article")).toContainText(original);
    await db`insert into public.workspace_settings(workspace_id,ai_data_scopes) values(${workspaceId},array['accounts']) on conflict(workspace_id) do update set ai_data_scopes=array['accounts']`;
    expect((await contexts[0].request.get(`/api/evidence/${receipt.id}`)).status()).toBe(404);
    expect((await db`select body from public.saved_analyses where job_id=${job}`)[0].body).toBe(original);
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    try {
      for (const workspace of workspaces) {
        for (const table of ["saved_analyses", "background_jobs", "financial_evidence_receipts", "transactions", "accounts"]) await db`delete from ${db("public." + table)} where workspace_id=${workspace}`;
        await db`delete from public.workspaces where id=${workspace} and owner_id in ${db(users)}`;
      }
      for (const user of users) expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
      if (users.length) {
        expect(await db`select id from auth.users where id in ${db(users)}`).toHaveLength(0);
        unlinkSync(recovery);
      }
    } finally { await db.end(); }
  }
});
