import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state || !process.env.SUPABASE_DB_URL || !process.env.E2E_USER_EMAIL, gatedSkipReason());
test.setTimeout(120_000);

test("an AI label is listed with its reason and undone", async ({ page }) => {
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const [{ id: workspace }] = await db`select w.id from public.workspaces w join auth.users u on u.id=w.owner_id where u.email=${process.env.E2E_USER_EMAIL!}`;
  const tag = crypto.randomUUID().slice(0, 8);
  const aiRow = `AI row ${tag}`, other = `Other ${tag}`;
  const [account] = await db`insert into public.accounts(workspace_id,name,type,currency_code) values(${workspace},${`Organize ${tag}`},'checking','EUR') returning id`;
  const [fun] = await db`insert into public.categories(workspace_id,name) values(${workspace},${other}) returning id`;
  const [ai] = await db`insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,status) values(${workspace},${account.id},current_date,${aiRow},-990,'EUR','posted') returning id`;
  await db`select public.apply_ai_organization(${workspace}::uuid, null, ${db.json([{ transaction_id: ai.id, expected_version: 0, category_id: fun.id, confidence: "high", reason: "Looked like a snack", identity_key: aiRow }])})`;
  try {
    await page.goto("/money/organize");
    const decision = page.getByRole("article", { name: aiRow });
    await expect(decision).toContainText("Looked like a snack");
    await decision.getByRole("button", { name: `Undo the labels on ${aiRow}` }).click();
    await expect(page.getByRole("status").filter({ hasText: "Undid 1 label" })).toBeVisible({ timeout: 30_000 });
    expect((await db`select category_id, organized_by from public.transactions where id=${ai.id}`)[0]).toEqual({ category_id: null, organized_by: null });
  } finally {
    await db.end();
  }
});
