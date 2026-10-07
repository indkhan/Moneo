import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";

test("reviewed pending settlement releases the obsolete hold and undo preserves both source observations", async ({ browser }) => {
  test.setTimeout(180_000);
  for (const key of ["SUPABASE_DB_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"])
    expect(process.env[key], `Required pending-hold acceptance prerequisite ${key}`).toBeTruthy();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" });
  let user: string | undefined, workspace: string | undefined;
  const journal = `.qa/pending-holds-${randomUUID()}.json`;
  try {
    expect((await db`select to_regclass('public.pending_hold_resolutions') as relation`)[0].relation,
      "Apply reviewed migration 202610060010 before this real HTTP/browser acceptance; rollback-only SQL is not deployment").not.toBeNull();
    const email = `qa-pending-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "pending-holds" } });
    expect(created.error).toBeNull(); user = created.data.user!.id;
    [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${user}`;
    mkdirSync(".qa", { recursive: true }); writeFileSync(journal, JSON.stringify({ project, user, workspace }));
    const account = randomUUID(), route = randomUUID(), pendingImport = randomUUID(), postedImport = randomUUID(), pendingSource = randomUUID(), postedSource = randomUUID();
    let pendingId = "", postedId = "";
    const now = new Date().toISOString();
    const pendingDate = new Date(Date.parse(now) - 2 * 86400000).toISOString().slice(0, 10);
    const postedDate = new Date(Date.parse(now) - 86400000).toISOString().slice(0, 10);
    const pendingOriginal = { Date: pendingDate, Amount: "-20", Reference: "synthetic-bank-1", State: "pending" };
    const postedOriginal = { Date: postedDate, Amount: "-18", Reference: "synthetic-bank-1", State: "posted" };
    await db.begin(async tx => {
      await tx`insert into public.workspace_settings(workspace_id,timezone,locale) values(${workspace!},'UTC','en-US')`;
      await tx`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping) values
        (${pendingImport},${workspace!},'synthetic-pending.csv',${workspace! + '/pending.csv'},${pendingImport},'queued',1,'{}'),
        (${postedImport},${workspace!},'synthetic-posted.csv',${workspace! + '/posted.csv'},${postedImport},'queued',1,'{}')`;
      await tx`select public.prepare_import_route(${pendingImport},${workspace!},1,${account},${route},'Synthetic pending cash','EUR',1)`;
      await tx`select public.prepare_import_route(${postedImport},${workspace!},1,${account},${route},'Synthetic pending cash','EUR',1)`;
      const ids = await tx`select public.stable_import_uuid(${pendingImport + ':transaction:2'}) as pending,public.stable_import_uuid(${postedImport + ':transaction:2'}) as posted`;
      pendingId = ids[0].pending; postedId = ids[0].posted;
      const payload = { accountName: "Synthetic pending cash", sourceId: pendingSource, transactionId: pendingId, rowNumber: 2, originalRow: pendingOriginal,
        externalId: "synthetic-bank-1", reviewReasons: [], postedOn: pendingDate, description: "Pending synthetic payment", amountMinor: "-2000", currencyCode: "EUR", status: "pending", kind: "ordinary", action: "new", reportProgress: true };
      await tx`select public.ingest_import_row(${pendingImport},${workspace!},1,${account},${tx.json(payload)})`;
      await tx`select public.finish_import_run(${pendingImport},${workspace!},1,null)`;
      await tx`select public.ingest_import_row(${postedImport},${workspace!},1,${account},${tx.json({ ...payload, sourceId: postedSource, transactionId: null, originalRow: postedOriginal, postedOn: postedDate, description: "Posted synthetic payment", amountMinor: "-1800", status: "posted", action: "review" })})`;
      await tx`select public.finish_import_run(${postedImport},${workspace!},1,null)`;
      await tx`insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance) values(${workspace!},${account},8000,'EUR',${now},'synthetic pending opening')`;
    });
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
    const page = await context.newPage();
    const forecast = page.locator("section").filter({ has: page.getByRole("heading", { name: "Liquid balance horizon", exact: true }) });
    await page.goto("/plan"); await expect(forecast).toContainText("EUR 60.00");
    await page.goto(`/import/${postedImport}/review`);
    const hold = page.getByRole("region", { name: "Pending hold resolution", exact: true });
    await expect(hold).toContainText("Outstanding EUR 20.00");
    await hold.getByLabel("Reviewed evidence / reason", { exact: true }).fill("Verified source reference and final capture; full authorization released");
    const response = page.waitForResponse(result => result.url().endsWith(`/api/imports/${postedImport}/review`) && result.request().method() === "POST");
    await hold.getByRole("button", { name: "Accept settlement and release hold", exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(page.getByText("No rows awaiting review.", { exact: true })).toBeVisible();
    await page.goto("/plan"); await expect(forecast).toContainText("EUR 80.00");
    await page.goto(`/money/transactions?transaction=${pendingId}`);
    await expect(hold).toContainText("Outstanding EUR 0.00");
    await hold.getByRole("button", { name: "Undo hold resolution", exact: true }).click();
    await expect(hold).toContainText("Outstanding EUR 20.00");
    await page.goto("/plan"); await expect(forecast).toContainText("EUR 60.00");
    await page.goto(`/money/transactions?transaction=${pendingId}`);
    await hold.getByLabel("Settlement evidence", { exact: true }).selectOption(postedId);
    await hold.getByLabel("Hold amount to release", { exact: true }).fill("5.00");
    await hold.getByLabel("Reviewed evidence / reason", { exact: true }).fill("Partial capture confirmed");
    await hold.getByRole("button", { name: "Confirm settlement and release hold", exact: true }).click();
    await expect(hold).toContainText("Outstanding EUR 15.00");
    await page.goto("/plan"); await expect(forecast).toContainText("EUR 65.00");
    expect((await db`select amount_minor::text,status from public.transactions where id=${pendingId}`)[0]).toEqual({ amount_minor: "-2000", status: "pending" });
    expect((await db`select amount_minor::text,status from public.transactions where id=${postedId}`)[0]).toEqual({ amount_minor: "-1800", status: "posted" });
    const sources = await db`select id,original_row from public.source_transactions where workspace_id=${workspace!} order by id`;
    expect(sources.find(row => row.id === pendingSource)?.original_row).toEqual(pendingOriginal);
    expect(sources.find(row => row.id === postedSource)?.original_row).toEqual(postedOriginal);
    expect((await db`select count(*)::int as count from public.pending_hold_resolutions where workspace_id=${workspace!}`)[0].count).toBe(2);
  } finally {
    await context.close();
    if (workspace) await db.begin(async tx => {
      await tx`delete from public.pending_hold_resolutions where workspace_id=${workspace!}`;
      await tx`delete from public.balance_snapshots where workspace_id=${workspace!}`;
      await tx`delete from public.transaction_sources where source_transaction_id in (select id from public.source_transactions where workspace_id=${workspace!})`;
      for (const table of ["transactions", "source_transactions", "imports", "data_sources", "accounts", "workspace_settings"])
        await tx`delete from ${tx("public." + table)} where workspace_id=${workspace!}`;
      await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user!}`;
    });
    if (user) { expect((await admin.auth.admin.deleteUser(user)).error).toBeNull(); unlinkSync(journal); }
    await db.end();
  }
});
