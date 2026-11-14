import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state || !process.env.SUPABASE_DB_URL || !process.env.E2E_USER_EMAIL, gatedSkipReason());
test.setTimeout(120_000);

// The organizer left rows blank with an open question, and labelled one row itself. The owner answers the question,
// the payee's rows are labelled, and the AI's own label is taken back from AI decided.
test("an organizer question is answered, labels the payee's rows, and an AI label is undone", async ({ page }) => {
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const [{ id: workspace }] = await db`select w.id from public.workspaces w join auth.users u on u.id=w.owner_id where u.email=${process.env.E2E_USER_EMAIL!}`;
  const tag = crypto.randomUUID().slice(0, 8);
  const payee = `Cafe ${tag}`, aiRow = `AI row ${tag}`, category = `Coffee ${tag}`, other = `Other ${tag}`;
  const [account] = await db`insert into public.accounts(workspace_id,name,type,currency_code) values(${workspace},${`Organize ${tag}`},'checking','EUR') returning id`;
  const [coffee] = await db`insert into public.categories(workspace_id,name) values(${workspace},${category}) returning id`;
  const [fun] = await db`insert into public.categories(workspace_id,name) values(${workspace},${other}) returning id`;
  const [identity] = await db`insert into public.organize_identities(workspace_id,kind,display_name) values(${workspace},'merchant',${payee}) returning id`;
  await db`insert into public.organize_identity_aliases(workspace_id,identity_id,alias_type,value) values(${workspace},${identity.id},'description_key',${payee.toLowerCase()})`;
  const rows = await db`insert into public.transactions(workspace_id,account_id,identity_id,posted_on,description,amount_minor,currency_code,status)
    select ${workspace},${account.id},${identity.id},current_date - n,${payee} || ' ' || n,-450,'EUR','posted' from generate_series(1,3) n returning id`;
  await db`insert into public.organize_questions(workspace_id,identity_key,identity_id,question,transaction_ids,created_by)
    values(${workspace},${payee.toLowerCase()},${identity.id},${`What is ${payee}?`},${rows.map(row => row.id)},'ai')`;
  const [ai] = await db`insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,status) values(${workspace},${account.id},current_date,${aiRow},-990,'EUR','posted') returning id`;
  await db`select public.apply_ai_organization(${workspace}::uuid, null, ${db.json([{ transaction_id: ai.id, expected_version: 0, category_id: fun.id, confidence: "high", reason: "Looked like a snack", identity_key: aiRow }])})`;
  const labelled = async () => (await db`select category_id, organized_by from public.transactions where id = any(${rows.map(row => row.id)})`);

  try {
    await page.goto("/money/organize");
    const question = page.getByRole("region", { name: `Question about ${payee}` });
    await expect(question).toContainText(`What is ${payee}?`);
    await question.getByRole("combobox", { name: `Category for ${payee}` }).selectOption({ label: category });
    await question.getByRole("button", { name: `Label the rows of ${payee}` }).click();
    await expect(page.getByRole("status").filter({ hasText: "Labelled 3 rows" })).toBeVisible({ timeout: 30_000 });
    expect(await labelled()).toEqual(Array(3).fill({ category_id: coffee.id, organized_by: "memory" }));
    expect((await db`select status from public.organize_questions where identity_id=${identity.id}`)[0].status).toBe("answered");

    // The AI's own label is listed with who made it and why, and Undo restores the blank row.
    await page.getByRole("link", { name: "AI decided" }).click();
    const decision = page.getByRole("article", { name: aiRow });
    await expect(decision).toContainText("Looked like a snack");
    await decision.getByRole("button", { name: `Undo the labels on ${aiRow}` }).click();
    await expect(page.getByRole("status").filter({ hasText: "Undid 1 label" })).toBeVisible({ timeout: 30_000 });
    expect((await db`select category_id, organized_by from public.transactions where id=${ai.id}`)[0]).toEqual({ category_id: null, organized_by: null });
  } finally {
    await db`delete from public.organize_questions where workspace_id=${workspace} and identity_id=${identity.id}`;
    await db`delete from public.organize_identities where id=${identity.id}`;
    await db.end();
  }
});
