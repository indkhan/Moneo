import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";
import { FALLBACK_CALCULATORS } from "../lib/artifacts/templates";

test("dated expenditure reports disclose exact FX evidence, originals, missing rates and revised posting dates", async ({ browser }) => {
  test.setTimeout(180_000);
  for (const key of ["SUPABASE_DB_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"])
    expect(process.env[key], `Required expenditure acceptance prerequisite ${key}`).toBeTruthy();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" });
  const journal = `.qa/expenditure-fx-${randomUUID()}.json`;
  let user: string | undefined, workspace: string | undefined;
  try {
    const email = `qa-expenditure-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "expenditure-fx" } });
    expect(created.error).toBeNull(); user = created.data.user!.id;
    [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${user}`;
    mkdirSync(".qa", { recursive: true }); writeFileSync(journal, JSON.stringify({ project, user, workspace }));
    const eurAccount = randomUUID(), usdAccount = randomUUID(), usdPosting = randomUUID(), rateId = randomUUID();
    const today = new Date().toISOString().slice(0, 10), first = `${today.slice(0, 7)}-01`;
    const revisedDate = first === today ? first : today;
    const original = { description: "Synthetic FX expense", posted_on: first, amount_minor: "-101", currency_code: "USD", account_id: usdAccount, status: "posted", kind: "ordinary" };
    await db.begin(async tx => {
      await tx`update public.workspaces set display_currency='EUR' where id=${workspace!}`;
      await tx`insert into public.workspace_settings(workspace_id,timezone,locale) values(${workspace!},'UTC','en-GB') on conflict(workspace_id) do update set timezone='UTC',locale='en-GB'`;
      await tx`insert into public.accounts(id,workspace_id,name,currency_code,type) values(${eurAccount},${workspace!},'Synthetic EUR','EUR','checking'),(${usdAccount},${workspace!},'Synthetic USD','USD','checking')`;
      await tx`insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind) values
        (${workspace!},${eurAccount},${first},'Synthetic EUR expense',-100,'EUR','posted','ordinary'),
        (${workspace!},${usdAccount},${first},'Synthetic refund',1,'USD','posted','refund'),
        (${workspace!},${usdAccount},${first},'Synthetic transfer fee',-1,'USD','posted','ordinary'),
        (${workspace!},${usdAccount},${first},'Synthetic principal',-1000,'USD','posted','transfer'),
        (${workspace!},${usdAccount},${first},'Synthetic pending',-1000,'USD','pending','ordinary')`;
      await tx`insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code) values(${usdPosting},${workspace!},${usdAccount},${first},${original.description},-101,'USD')`;
      await tx`insert into public.manual_transaction_entries(workspace_id,transaction_id,request_id,actor_id,original_record) values(${workspace!},${usdPosting},${randomUUID()},${user!},${tx.json(original)})`;
      await tx`insert into public.fx_rates(id,workspace_id,from_currency,to_currency,rate_text,rate_date,source) values(${rateId},${workspace!},'USD','EUR','0.905',${first},'synthetic posting-date evidence')`;
    });
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
    const page = await context.newPage();
    const panel = page.locator("div.rounded-xl").filter({ has: page.getByRole("heading", { name: "Spending this month", exact: true }) }).last();
    await page.goto("/?spendingView=base");
    await expect(panel.getByRole("link", { name: "Base currency (EUR)", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(panel).toContainText("EUR 1.91");
    await panel.getByText("Conversion evidence and exclusions", { exact: true }).click();
    await expect(panel).toContainText(rateId);
    await expect(panel).toContainText("synthetic posting-date evidence");
    await expect(panel).toContainText("rounded minor units -91");
    await expect(panel).toContainText("transfer");
    await expect(panel).toContainText("pending");
    const artifact = await auth.rpc("create_trusted_artifact", { p_kind: "spending_explorer", p_name: "Synthetic dated expenditure" });
    expect(artifact.error).toBeNull();
    await page.goto(`/ai/library/${artifact.data.id}?spendingView=base`);
    const explorer = page.locator("div.rounded-xl").filter({ has: page.getByRole("heading", { name: "This month", exact: true }) }).last();
    await expect(explorer).toContainText("EUR 1.91");
    const editor = page.getByRole("region", { name: "Edit calculator version", exact: true });
    await editor.locator(".cm-content").fill(FALLBACK_CALCULATORS.spending_explorer.source);
    await editor.getByLabel("Manifest (JSON)", { exact: true }).fill(JSON.stringify(FALLBACK_CALCULATORS.spending_explorer.manifest));
    await editor.getByRole("button", { name: "Save new version", exact: true }).click();
    await expect(page.getByRole("region", { name: "Generated calculator output", exact: true }).locator("dd").first()).toHaveText("191", { timeout: 20_000 });
    await explorer.getByText("Conversion evidence and exclusions", { exact: true }).click();
    await expect(explorer).toContainText(rateId);
    await expect(explorer).toContainText("Statement completeness is not established");
    await explorer.getByRole("link", { name: "Original currencies", exact: true }).click();
    await expect(explorer).toContainText("USD: USD 1.01 original spending");
    await page.goto("/?spendingView=base");
    await panel.getByRole("link", { name: "Original currencies", exact: true }).click();
    await expect(panel).toContainText("USD: USD 1.01 original spending");
    await expect(panel).toContainText("EUR: EUR 1.00 original spending");
    // Revised persisted posting fixture proves report recomputation. This is not
    // an amount/date editing UI test: that UI currently edits category/note only.
    await db`update public.transactions set amount_minor=-200,posted_on=${revisedDate},version=version+1 where id=${usdPosting} and workspace_id=${workspace!}`;
    if (revisedDate !== first) await db`insert into public.fx_rates(workspace_id,from_currency,to_currency,rate_text,rate_date,source) values(${workspace!},'USD','EUR','2',${revisedDate},'synthetic revised-date evidence')`;
    await page.goto("/?spendingView=base");
    await expect(panel).toContainText(revisedDate === first ? "EUR 2.81" : "EUR 5.00");
    await panel.getByText("Conversion evidence and exclusions", { exact: true }).click();
    await expect(panel).toContainText("correction version 1");
    if (revisedDate !== first) await expect(panel).toContainText("synthetic revised-date evidence");
    expect((await db`select original_record from public.manual_transaction_entries where transaction_id=${usdPosting} and workspace_id=${workspace!}`)[0].original_record).toEqual(original);
    await db`delete from public.fx_rates where workspace_id=${workspace!} and rate_date=${revisedDate}`;
    await page.goto("/?spendingView=base");
    await expect(panel).toContainText("Incomplete base-currency report");
    await expect(panel).toContainText("Available converted subtotal");
    await panel.getByText("Conversion evidence and exclusions", { exact: true }).click();
    await expect(panel).toContainText("missing-rate");
    await page.goto(`/?spendingView=base&account=${eurAccount}`);
    await expect(panel).toContainText("EUR 1.00");
    await expect(panel).not.toContainText("Incomplete base-currency report");
  } finally {
    await context.close().catch(() => {});
    if (workspace) await db.begin(async tx => {
      await tx`update public.artifacts set active_version_id=null where workspace_id=${workspace!}`;
      for (const table of ["artifact_state", "artifact_versions", "artifacts"])
        await tx`delete from ${tx("public." + table)} where workspace_id=${workspace!}`;
      for (const table of ["fx_rates", "manual_transaction_entries", "correction_events", "transactions", "accounts", "workspace_settings"])
        await tx`delete from ${tx("public." + table)} where workspace_id=${workspace!}`;
      await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user!}`;
    });
    if (user) { expect((await admin.auth.admin.deleteUser(user)).error).toBeNull(); unlinkSync(journal); }
    await db.end();
  }
});
