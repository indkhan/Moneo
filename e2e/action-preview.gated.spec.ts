import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());

test("a category proposal shows its entries, applies once, and reports where to undo it", async ({ page }) => {
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const [{ id: workspace }] = await db`select w.id from public.workspaces w join auth.users u on u.id=w.owner_id where u.email=${process.env.E2E_USER_EMAIL!}`;
  const label = `Preview QA ${crypto.randomUUID().slice(0, 8)}`;
  const [account] = await db`insert into public.accounts(workspace_id,name,type,currency_code) values(${workspace},${label},'checking','EUR') returning id`;
  const [category] = await db`insert into public.categories(workspace_id,name) values(${workspace},${label}) returning id`;
  const [row] = await db`insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,status) values(${workspace},${account.id},current_date,${label},-1234,'EUR','posted') returning id`;
  await page.goto(`/ai/actions/preview?ids=${row.id}&category=${category.id}`);
  await expect(page.getByRole("list", { name: "Entries to change" })).toContainText(`Uncategorized → ${label}`);
  await page.getByRole("button", { name: "Apply to 1 transaction", exact: true }).click();
  await expect(page).toHaveURL(/\/money\/transactions\?.*applied=1/, { timeout: 30_000 });
  await expect(page.getByRole("status").filter({ hasText: "Updated 1 transaction" })).toBeVisible();
  await expect.poll(async () => (await db`select category_id from public.transactions where id=${row.id}`)[0].category_id).toBe(category.id);
  await db.end();
});
