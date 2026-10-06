import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";
import { loadBalanceEvidence, resolveBalances } from "../lib/finance/balances";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires disposable real Supabase authentication");

test("explicit booked-balance review covers timestamped and date-only activity, retains later postings and supports undo", async ({ browser }) => {
  test.setTimeout(120_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const [migration] = await db`select to_regprocedure('public.record_manual_balance(uuid,text,date,boolean,jsonb,uuid,integer,uuid)') present`;
  if (!migration.present) { await db.end(); test.skip(true, "Requires applied candidate migration 202610060001; rollback SQL acceptance does not expose it to the browser"); }
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `qa-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "reviewed-balance" } });
  expect(created.error).toBeNull();
  const user = created.data.user!.id;
  const [workspace] = await db`select id from public.workspaces where owner_id=${user}`;
  const recovery = `.qa/reviewed-balance-${user}.json`;
  mkdirSync(".qa", { recursive: true }); writeFileSync(recovery, JSON.stringify({ project, user, workspace: workspace.id }));
  const context = await browser.newContext({ baseURL: "http://localhost:3000" });
  try {
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
    const account = randomUUID();
    await db`insert into public.workspace_settings(workspace_id,locale,timezone) values(${workspace.id},'en-US','Europe/Berlin')`;
    await db`insert into public.accounts(id,workspace_id,name,currency_code,type) values(${account},${workspace.id},'Synthetic reviewed cash','EUR','checking')`;
    await db`insert into public.transactions(workspace_id,account_id,posted_on,posted_at,description,amount_minor,currency_code)
      values(${workspace.id},${account},(now() at time zone 'Europe/Berlin')::date,now()-interval '1 minute','Synthetic morning posting',-100,'EUR')`;
    await db`insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code)
      values(${workspace.id},${account},(now() at time zone 'Europe/Berlin')::date,'Synthetic date-only posting',-200,'EUR')`;
    const page = await context.newPage();
    await page.goto("/");
    const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "Synthetic reviewed cash", exact: true }) });
    await card.getByLabel("Synthetic reviewed cash balance", { exact: true }).fill("100.00");
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card).toContainText("ambiguous", { timeout: 30_000 });
    await card.getByText(/Review activity included in today's booked balance/).click();
    await expect(card).toContainText("Synthetic morning posting");
    await expect(card).toContainText("Synthetic date-only posting");
    await card.getByLabel(/I checked today's booked balance/).check();
    await card.getByLabel("Synthetic reviewed cash balance", { exact: true }).fill("100.00");
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card).toContainText("current", { timeout: 30_000 });
    async function cash() { const e = await loadBalanceEvidence(admin, workspace.id); return resolveBalances(e.accounts, e.snapshots, e.ledger, e.asOf, "Europe/Berlin")[0].balance; }
    expect(await cash()).toMatchObject({ amount_minor: "10000", reconciled_rows: 0 });
    await db`insert into public.transactions(workspace_id,account_id,posted_on,posted_at,description,amount_minor,currency_code)
      values(${workspace.id},${account},(clock_timestamp() at time zone 'Europe/Berlin')::date,clock_timestamp(),'Synthetic later posting',-250,'EUR')`;
    await page.reload();
    expect(await cash()).toMatchObject({ amount_minor: "9750", reconciled_rows: 1 });
    await card.getByText("Manual balance history and undo", { exact: true }).click();
    await card.getByRole("button", { name: "Undo balance", exact: true }).first().click();
    await expect(card).toContainText("ambiguous", { timeout: 30_000 });
    const history = await db`select boundary_kind,undone_at,covered_transactions from public.balance_snapshots where account_id=${account} order by created_at desc`;
    expect(history).toHaveLength(2); expect(history[0].undone_at).not.toBeNull(); expect(history[0].covered_transactions).toHaveLength(2);
    expect((await db`select count(*)::integer count from public.transactions where account_id=${account}`)[0].count).toBe(3);
  } finally {
    await context.close().catch(() => {});
    await db.begin(async tx => {
      for (const table of ["balance_snapshots", "transactions", "accounts", "workspace_settings"]) await tx`delete from ${tx("public." + table)} where workspace_id=${workspace.id}`;
      await tx`delete from public.workspaces where id=${workspace.id} and owner_id=${user}`;
    });
    expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
    unlinkSync(recovery); await db.end();
  }
});
