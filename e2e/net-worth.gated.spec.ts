import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

// The net worth flows in the browser, on the QA workspace, with made-up data seeded straight into its tables.
const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());

const shots = process.env.E2E_SCREENSHOT_DIR;
async function shot(page: Page, name: string) {
  if (!shots) return;
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });
}
const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
test.afterAll(async () => { await db.end(); });

async function workspaceId() {
  const [row] = await db`select w.id from public.workspaces w join auth.users u on u.id=w.owner_id where u.email=${process.env.E2E_USER_EMAIL!}`;
  return row.id as string;
}
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

test("a bank transfer with one side so far, and money moved between accounts, stay honest on Home and Wealth", async ({ page }) => {
  test.setTimeout(120_000);
  const workspace = await workspaceId(), suffix = randomUUID().slice(0, 8);
  const [bank] = await db`insert into public.accounts(workspace_id,name,currency_code,type) values(${workspace},${`Transit bank ${suffix}`},'EUR','checking') returning id`;
  const [other] = await db`insert into public.accounts(workspace_id,name,currency_code,type) values(${workspace},${`Transit other ${suffix}`},'EUR','savings') returning id`;
  await db`insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind) values(${workspace},${bank.id},100000,'EUR',${`${day(-60)}T00:00:00Z`},'synthetic','date_only'),(${workspace},${other.id},10000,'EUR',${`${day(-60)}T00:00:00Z`},'synthetic','date_only')`;
  const out = randomUUID(), into = randomUUID();
  await db`insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind) values(${out},${workspace},${bank.id},${day(-5)},'Synthetic move out',-5000,'EUR','posted','transfer'),(${into},${workspace},${other.id},${day(-3)},'Synthetic move in',5000,'EUR','posted','transfer')`;
  await db`update public.transactions set transfer_id=${into} where id=${out}`;
  await db`update public.transactions set transfer_id=${out} where id=${into}`;
  const provider = `E2E-${suffix}`;
  await db`insert into public.scalable_transfers(workspace_id,provider_id,type,amount_minor,currency_code,occurred_at,on_date,status,description) values(${workspace},${provider},'DEPOSIT',7700,'EUR',${`${day(-1)}T10:00:00Z`},${day(-1)},'SETTLED','Synthetic deposit')`;
  try {
    await page.goto("/money/wealth");
    await expect(page.getByRole("heading", { name: "Needs a look" })).toBeVisible({ timeout: 30_000 });
    await page.getByText(/one side so far/).click();
    await expect(page.getByRole("listitem").filter({ hasText: "Scalable deposit" })).toContainText("EUR 77.00");
    await shot(page, "wealth-problems");
    await page.goto("/");
    await expect(page.getByText(/one side showing so far/)).toBeVisible({ timeout: 30_000 });
    await shot(page, "home-net-worth");
  } finally {
    await db`delete from public.scalable_transfers where workspace_id=${workspace} and provider_id=${provider}`;
    await db`delete from public.correction_events where transaction_id in (${out},${into})`;
    await db`update public.transactions set transfer_id=null where id in (${out},${into})`;
    await db`delete from public.transactions where id in (${out},${into})`;
    await db`delete from public.balance_snapshots where account_id in (${bank.id},${other.id})`;
    await db`delete from public.money_metadata_events where entity_id in (${bank.id},${other.id})`;
    await db`delete from public.accounts where id in (${bank.id},${other.id})`;
  }
});

test("archiving an account with money asks what happened to it, and moving it keeps net worth the same", async ({ page }) => {
  test.setTimeout(150_000);
  const suffix = randomUUID().slice(0, 8), name = `Closing bank ${suffix}`, target = `Closing target ${suffix}`;
  const workspace = await workspaceId();
  await db`insert into public.accounts(workspace_id,name,currency_code,type) values(${workspace},${name},'EUR','checking'),(${workspace},${target},'EUR','savings')`;
  const accounts = await db`select id,name from public.accounts where name in (${name},${target})`;
  for (const account of accounts) await db`insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind) values(${workspace},${account.id},${account.name === name ? 25000 : 5000},'EUR',${`${day(-10)}T00:00:00Z`},'synthetic','date_only')`;
  await page.goto("/money/accounts");
  const article = page.locator("article, li, section").filter({ has: page.getByRole("textbox", { name: `Name of ${name}`, exact: true }) }).last();
  const totalBefore = await db`select sum(amount_minor)::text total from public.balance_snapshots where account_id in (${accounts[0].id},${accounts[1].id})`;
  await article.getByText("More", { exact: true }).click();
  await article.getByRole("button", { name: `Archive ${name}`, exact: true }).click();
  await expect(article.getByText(/still holds EUR 250.00. What happens to it\?/)).toBeVisible();
  await shot(page, "accounts-archive-question");
  await article.getByRole("radio", { name: "I moved it to another of my accounts" }).check();
  await article.getByRole("combobox").last().selectOption({ label: target });
  await article.getByRole("button", { name: "Archive account", exact: true }).click();
  await expect(page.getByRole("region", { name: "Archived accounts" }).or(page.getByRole("heading", { name: /Archived accounts/ })).first()).toBeVisible({ timeout: 30_000 });
  // Linked rows, equal and opposite, with the money now in the other account.
  const rows = await db`select amount_minor::text,kind,transfer_id is not null linked from public.transactions where account_id in (${accounts[0].id},${accounts[1].id}) order by amount_minor`;
  expect(rows).toEqual([{ amount_minor: "-25000", kind: "transfer", linked: true }, { amount_minor: "25000", kind: "transfer", linked: true }]);
  expect(totalBefore[0].total).toBe("30000");
  await expect(page.getByRole("textbox", { name: `Name of ${target}`, exact: true }).locator("xpath=ancestor::*[self::article or self::li or self::section][1]")).toContainText("EUR 300.00");
});

test("a repeated bank row can be resolved from review without posting twice, and undone", async ({ page }) => {
  test.setTimeout(120_000);
  const workspace = await workspaceId(), suffix = randomUUID().slice(0, 8);
  const account = randomUUID(), imported = randomUUID(), source = randomUUID(), route = randomUUID();
  await db`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping,review_rows) values(${imported},${workspace},${`Repeat ${suffix} bank sync ${day(0)}.csv`},${`${workspace}/repeat-${suffix}.csv`},${imported},'queued',1,${db.json({ rowContractVersion: "normalized-row-v1", completeWindow: true })},0)`;
  await db`select public.prepare_import_route(${imported},${workspace},1,${account},${route},${`Repeat bank ${suffix}`},'EUR',1)`;
  const [canonical] = await db`insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind) values(${workspace},${account},${day(-2)},'Synthetic repeat',-1234,'EUR','posted','ordinary') returning id`;
  const row = { postedOn: day(-2), description: "Synthetic repeat", amountMinor: "-1234", currencyCode: "EUR", status: "posted", kind: "ordinary", reviewReasons: [] };
  await db`insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row,status,normalized_row) values(${source},${workspace},${imported},2,${db.json({ Amount: "-12.34" })},'review',${db.json({ accountId: account, routeKey: JSON.stringify([`Repeat bank ${suffix}`, "EUR"]), mapping: {}, row })})`;
  await db`update public.imports set status='completed',review_rows=1 where id=${imported}`;
  try {
    await page.goto(`/import/${imported}/review`);
    await expect(page.getByText(/repeats? what your ledger already has/)).toBeVisible({ timeout: 30_000 });
    await shot(page, "import-repeats");
    await page.getByRole("button", { name: /Resolve/ }).click();
    await expect(page.getByText(/repeats? what your ledger already has/)).toHaveCount(0, { timeout: 30_000 });
    const [saved] = await db`select status from public.source_transactions where id=${source}`;
    expect(saved.status).toBe("rejected");
    const [count] = await db`select count(*)::int n from public.transactions where account_id=${account}`;
    expect(count.n).toBe(1);
    const [decision] = await db`select action,undone_at from public.import_row_decisions where source_id=${source}`;
    expect(decision).toMatchObject({ action: "rejected", undone_at: null });
  } finally {
    await db`delete from public.import_row_decisions where source_id=${source}`;
    await db`delete from public.source_transactions where id=${source}`;
    await db`delete from public.import_control_events where import_id=${imported}`;
    await db`delete from public.import_staging where import_id=${imported}`;
    await db`update public.imports set source_id=null where id=${imported}`;
    await db`delete from public.imports where id=${imported}`;
    await db`delete from public.transactions where id=${canonical.id}`;
    await db`delete from public.data_sources where id=${route}`;
    await db`delete from public.accounts where id=${account}`;
  }
});
