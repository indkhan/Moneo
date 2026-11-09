import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires Supabase and migration 202611040004");

test("individual accept and reject undo retain source and decision history and refuse later changes", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  const db = postgres(connection.toString(), { max: 1 });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `qa-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error).toBeNull();
  const user = created.data.user!.id;
  const journal = `.qa/import-row-undo-${user}.json`;
  mkdirSync(".qa", { recursive: true }); writeFileSync(journal, JSON.stringify({ project, user, qaTest: "import-row-undo" }));
  const context = await browser.newContext({ baseURL });
  try {
    expect((await db`select to_regprocedure('public.undo_import_row_decision(uuid)') is not null ready`)[0].ready, "Apply reviewed migration 202611040004 before browser acceptance").toBe(true);
    const [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${user}`;
    const account = randomUUID(), imported = randomUUID(), source = randomUUID();
    await db`insert into public.accounts(id,workspace_id,name,currency_code) values(${account},${workspace},'Row undo fixture','EUR')`;
    const mapping = { accountName: "Row undo fixture", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", dateFormat: "iso", amountSign: "signed", numericConvention: "decimal-dot", rowDecisions: [{ rowNumber: 2, action: "correct", values: { Description: "Row undo purchase" } }] };
    await db`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,review_rows,mapping,route_accounts)
      values(${imported},${workspace},'row-undo.csv','synthetic',${imported},'completed',1,1,${db.json(mapping)},${db.json({ route: account })})`;
    const original = { Date: "2026-11-01", Description: "Exact original row", Amount: "-12.00" };
    const row = { sourceId: source, rowNumber: 2, originalRow: original, description: "Row undo purchase", postedOn: "2026-11-01", amountMinor: "-1200", currencyCode: "EUR", status: "posted", kind: "ordinary", reviewReasons: [] };
    await db`insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row,status,normalized_row)
      values(${source},${workspace},${imported},2,${db.json(original)},'review',${db.json({ row, mapping, routeKey: "route", accountId: account })})`;
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
    const page = await context.newPage(); page.setDefaultTimeout(30_000);
    await page.goto(`/import/${imported}/review`);
    const decided = page.getByRole("region", { name: "Decided rows" });
    const act = async (click: () => Promise<unknown>, status: number, result: Record<string, unknown>) => {
      const [response] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === `/api/imports/${imported}/review` && response.request().method() === "POST"),
        click(),
      ]);
      expect(response.status()).toBe(status);
      expect(await response.json()).toMatchObject(result);
    };
    const undo = async (refused = false) => {
      await decided.getByRole("button", { name: "Undo decision, row 2", exact: true }).click();
      await act(() => decided.getByRole("button", { name: "Confirm undo decision", exact: true }).click(), refused ? 409 : 200,
        refused ? { error: "Undo later transaction changes before reopening this row" } : { status: "review" });
    };
    await act(() => page.getByRole("button", { name: "Accept as new, row 2", exact: true }).click(), 200, { status: "accepted" });
    await expect(decided).toContainText("Row 2", { timeout: 30_000 });
    await undo();
    await expect(page.getByRole("button", { name: "Accept as new, row 2", exact: true })).toBeVisible();
    await expect(page.getByText(/Previously accepted; reopened/)).toBeVisible();
    expect((await db`select id,original_row,status from public.source_transactions where id=${source}`)[0]).toEqual({ id: source, original_row: original, status: "review" });
    expect((await db`select count(*)::int count from public.transactions where workspace_id=${workspace}`)[0].count).toBe(0);
    await act(() => page.getByRole("button", { name: "Reject, row 2", exact: true }).click(), 200, { status: "rejected" });
    await expect(decided).toContainText("Rejected, not in your totals", { timeout: 30_000 });
    await undo();
    await expect(page.getByRole("button", { name: "Accept as new, row 2", exact: true })).toBeVisible();
    await act(() => page.getByRole("button", { name: "Accept as new, row 2", exact: true }).click(), 200, { status: "accepted" });
    await expect(decided).toContainText("Row 2", { timeout: 30_000 });
    const [{ transaction_id: target }] = await db`select transaction_id from public.transaction_sources where source_transaction_id=${source}`;
    await expect(decided.getByRole("link", { name: "Open the transaction", exact: true })).toHaveAttribute("href", `/money/transactions?transaction=${target}`);
    await db`update public.transactions set description='Later reviewed edit' where id=${target}`;
    await undo(true);
    await expect(decided.getByRole("alert")).toContainText("Undo later transaction changes");
    expect((await db`select status,original_row from public.source_transactions where id=${source}`)[0]).toEqual({ status: "accepted", original_row: original });
    const events = await db`select action,undone_at is not null undone from public.import_row_decisions where source_id=${source} order by created_at`;
    expect([...events]).toEqual([{ action: "accepted", undone: true }, { action: "rejected", undone: true }, { action: "accepted", undone: false }]);
  } finally {
    await context.close();
    try {
      await db.begin(async tx => {
        await tx`select set_config('request.jwt.claim.sub',${user},true)`;
        await tx`select public.reset_workspace()`;
        await tx`delete from public.categories where workspace_id in (select id from public.workspaces where owner_id=${user})`;
        await tx`delete from public.categories where workspace_id in (select id from public.workspaces where owner_id=${user})`;
        await tx`delete from public.workspaces where owner_id=${user}`;
      });
      expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
      unlinkSync(journal);
    } finally { await db.end(); }
  }
});
