import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";

test("source-only overlap gates budget remainder; rejection resolves coverage without changing accepted spending", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  for (const key of ["SUPABASE_DB_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]) expect(process.env[key], `${key} required`).toBeTruthy();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = postgres(process.env.SUPABASE_DB_URL!, { ssl: "require", max: 1 });
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const run = randomUUID(), account = randomUUID(), imported = randomUUID(), overlap = randomUUID(), source = randomUUID(), category = randomUUID();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
  const email = `qa-${run}@example.invalid`, password = randomBytes(24).toString("hex"), journal = `.qa/source-coverage-${run}.json`;
  let user: string | undefined, workspace: string | undefined;
  mkdirSync(".qa", { recursive: true });
  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "mne008-source-coverage", run_id: run } });
    expect(created.error).toBeNull(); user = created.data.user!.id;
    [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${user}`;
    writeFileSync(journal, JSON.stringify({ user, workspace, run }));
    await db.begin(async tx => {
      await tx`insert into public.categories(id,workspace_id,name) values(${category},${workspace!},'Synthetic coverage budget')`;
      for (const id of [imported, overlap]) {
        await tx`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping) values(${id},${workspace!},'synthetic.csv',${`${workspace}/synthetic.csv`},${id},'queued',1,${tx.json({ accountName: "Synthetic coverage account", currencyCode: "EUR", rowContractVersion: "normalized-row-v1" })})`;
        await tx`select public.prepare_import_route(${id},${workspace!},1,${account},${randomUUID()},'Synthetic coverage account','EUR',1)`;
        await tx`select public.ingest_import_row(${id},${workspace!},1,${account},${tx.json({ accountName: "Synthetic coverage account", sourceId: id === imported ? randomUUID() : source, transactionId: id === imported ? randomUUID() : null, balanceId: randomUUID(), rowNumber: 2, originalRow: { Description: "Synthetic overlap", Amount: "-10.00" }, postedOn: today, description: "Synthetic overlap", amountMinor: "-1000", currencyCode: "EUR", status: "posted", kind: "ordinary", reviewReasons: [], action: id === imported ? "new" : "review" })})`;
        await tx`select public.finish_import_run(${id},${workspace!},1,null)`;
      }
      await tx`update public.transactions set category_id=${category} where workspace_id=${workspace!}`;
      await tx`insert into public.spending_plans(workspace_id,category_id,currency_code,limit_minor) values(${workspace!},${category},'EUR',10000)`;
    });
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, key, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => { for (const value of values) cookies.set(value.name, value.value); } } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
    const page = await context.newPage();
    await page.goto("/");
    const detail = page.locator("details").filter({ hasText: "1 unresolved source observation(s)" }).first();
    await detail.locator("summary").click();
    await expect(detail).toContainText("Statement intervals and full account coverage are unknown");
    await expect(detail).toContainText("neither upper nor lower bounds");
    await page.goto("/plan/spending");
    const plan = page.locator("li").filter({ has: page.getByRole("heading", { name: "Synthetic coverage budget", exact: true }) });
    await expect(plan).toContainText("EUR 10.00 of EUR 100.00");
    await expect(plan).not.toContainText("EUR 90.00 left in accepted records");
    await plan.locator("details summary").click();
    await expect(plan).toContainText("1 unresolved source observation(s)");
    const rejected = await context.request.post(`/api/imports/${overlap}/review`, { data: { sourceId: source, action: "reject" } });
    expect(rejected.status()).toBe(200);
    await page.reload();
    await expect(plan).toContainText("EUR 10.00 of EUR 100.00");
    await expect(plan).toContainText("EUR 90.00 left in accepted records");
    await plan.locator("details summary").click();
    await expect(plan).toContainText("0 unresolved source observation(s)");
    await expect(plan).toContainText("1 rejected");
    const [{ original_row, status }] = await db`select original_row,status from public.source_transactions where id=${source} and workspace_id=${workspace!}`;
    expect(status).toBe("rejected"); expect(original_row).toEqual({ Description: "Synthetic overlap", Amount: "-10.00" });
  } finally {
    await context.close();
    if (workspace) await db.begin(async tx => {
      await tx`delete from public.transaction_sources where source_transaction_id in (select id from public.source_transactions where workspace_id=${workspace!})`;
      for (const table of ["balance_snapshots", "spending_plan_limits", "spending_plans", "transactions", "source_transactions", "imports", "data_sources", "accounts", "categories", "workspace_settings"])
        await tx`delete from ${tx("public." + table)} where workspace_id=${workspace!}`;
      await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user!}`;
    });
    if (user) { expect((await admin.auth.admin.deleteUser(user)).error).toBeNull(); expect((await db`select id from auth.users where id=${user}`).length).toBe(0); unlinkSync(journal); }
    if (workspace) expect((await db`select id from public.workspaces where id=${workspace}`).length).toBe(0);
    await db.end();
  }
});
