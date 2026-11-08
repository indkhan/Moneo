// Calculated Scalable values on Home and Wealth, seeded into the QA workspace and removed afterwards. Needs no Scalable and no AI.
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());
test.describe.configure({ mode: "serial" });

const ACCOUNT = crypto.randomUUID(), ITEM = crypto.randomUUID(), CONNECTION = crypto.randomUUID();
let db: postgres.Sql, workspace: string, owner: string;
// Berlin is the QA workspace's timezone; the first sync is today, so every earlier day is calculated.
const dayOf = (back: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date(Date.now() - back * 86400000));

test.beforeAll(async () => {
  db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  [{ id: workspace, owner_id: owner }] = await db`select w.id, w.owner_id from public.workspaces w join auth.users u on u.id=w.owner_id where u.email=${process.env.E2E_USER_EMAIL!}`;
  // The bank is known only for the last 40 days; the portfolio's calculated days go back further.
  await db`insert into public.accounts(id, workspace_id, name, currency_code) values (${ACCOUNT}, ${workspace}, 'History QA bank', 'EUR')`;
  await db`insert into public.balance_snapshots(workspace_id, account_id, amount_minor, currency_code, as_of, provenance) values (${workspace}, ${ACCOUNT}, 100000, 'EUR', ${`${dayOf(40)}T00:00:00Z`}, 'synthetic')`;
  const item = { id: ITEM, workspace_id: workspace, kind: "asset", name: "Scalable cash", currency_code: "EUR", amount_minor: 500010, as_of: dayOf(0) };
  await db`insert into public.wealth_items ${db(item)}`;
  await db`insert into public.wealth_events(workspace_id, item_id, actor_id, request_id, before, after) values (${workspace}, ${ITEM}, ${owner}, ${crypto.randomUUID()}, null, ${db.json({ ...item, amount_minor: "500010", removed_at: null, linked_account_id: null })})`;
  const portfolio = { currency: "EUR", asOf: dayOf(0), valuedAt: null, totalMinor: "500010", securitiesMinor: "0", cryptoMinor: "0", cashMinor: "500010", performance: [], itemIds: [ITEM] };
  await db`insert into public.scalable_connections(id, workspace_id, client_id, redirect_uri, status, tokens_encrypted, portfolio, history_status, history_checked_on)
    values (${CONNECTION}, ${workspace}, 'qa', 'http://localhost:3000/api/scalable/callback', 'active', 'sealed', ${db.json(portfolio)}, 'ok', ${dayOf(0)})`;
  const rows = Array.from({ length: 400 }, (_, index) => ({ workspace_id: workspace, on_date: dayOf(400 - index), currency_code: "EUR", securities_minor: 500000, crypto_minor: 0, cash_minor: 0, total_minor: 500000 }));
  await db`insert into public.scalable_value_history ${db(rows)}`;
});
test.afterAll(async () => {
  await db`delete from public.scalable_value_history where workspace_id=${workspace}`;
  await db`delete from public.scalable_connections where id=${CONNECTION}`;
  await db`delete from public.wealth_events where item_id=${ITEM}`;
  await db`delete from public.wealth_items where id=${ITEM}`;
  await db`delete from public.balance_snapshots where account_id=${ACCOUNT}`;
  await db`delete from public.accounts where id=${ACCOUNT}`;
  await db.end();
});

test("Home's month change compares with the calculated value, so connecting Scalable is no gain", async ({ page }) => {
  await page.goto("/");
  const overview = page.getByRole("region", { name: "Net worth" });
  // 1,000 bank + 5,000 calculated at last month's end, 1,000 + 5,000.10 now.
  await expect(overview).toContainText(/this month/);
  await expect(overview).toContainText(/\+\S*\s?0[.,]10\S*\s*this month/);
  await expect(overview).not.toContainText(/\+\S*\s?5[.,]000/);
});

test("Wealth counts calculated days in net worth only where bank data is known, and explains the Scalable chart", async ({ page }) => {
  await page.goto("/money/wealth");
  const table = page.getByRole("region", { name: "Net worth" }).first();
  await table.getByText("Net worth by month").click();
  await expect(table.getByRole("table")).toContainText(/6[.,]000[.,]00/);
  await expect(table.getByRole("table")).toContainText("Nothing recorded");
  const panel = page.getByRole("region", { name: "Scalable Capital" });
  await expect(panel).toContainText("are calculated from your transactions and past prices");
  await expect(panel).toContainText("further than a year back are monthly.");
  await expect(panel.getByRole("img", { name: /Scalable portfolio value/ })).toBeVisible();
  await expect(panel).not.toContainText("since then");
  // Calculated days are not real records: the source history lists only what was saved.
  await page.locator("#wealth-history summary").click();
  await expect(page.locator("#wealth-history li")).toHaveCount(1);
});

test("a failed check keeps the chart as it was and stays quiet about it", async ({ page }) => {
  await db`delete from public.scalable_value_history where workspace_id=${workspace}`;
  await db`update public.scalable_connections set history_status='failed' where id=${CONNECTION}`;
  await page.goto("/money/wealth");
  const panel = page.getByRole("region", { name: "Scalable Capital" });
  await expect(panel).toContainText("Earlier days could not be worked out");
  await expect(panel).not.toContainText("are calculated from");
});
