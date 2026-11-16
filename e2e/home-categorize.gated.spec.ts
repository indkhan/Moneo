import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomUUID, randomBytes } from "node:crypto";
import postgres from "postgres";
import { deleteDisposableUser } from "./fixtures";

test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_DB_URL || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  "Requires configured Supabase admin/auth/database for a disposable real user");

const GROUPS = 36;

test("the Home review shows every uncategorized group at once, files them under one category, and lets a group be changed afterwards (#230)", async ({ browser }) => {
  test.setTimeout(240_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const email = `qa-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "home-categorize" } });
  expect(created.error).toBeNull();
  const user = created.data.user!.id;
  const context = await browser.newContext();
  try {
    const [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${user}`;
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, key, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => { for (const value of values) cookies.set(value.name, value.value); } } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
    const [account] = await db`insert into public.accounts(workspace_id,name,type,currency_code) values(${workspace},'Checking','checking','EUR') returning id`;
    const names = Array.from({ length: GROUPS }, (_, index) => `Shop${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}x`);
    await db`insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,status)
      select ${workspace},${account.id},current_date - n,${db.array(names)}[g] || ' purchase',-450,'EUR','posted' from generate_series(1,${GROUPS}) g, generate_series(1,2) n`;
    const categories = async () => (await db`select c.name, count(*)::int as count from public.transactions t left join public.categories c on c.id=t.category_id where t.workspace_id=${workspace} group by c.name`);
    const page = await context.newPage();

    await page.goto("/");
    await page.getByRole("button", { name: /^Review: .* need a category$/ }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("group", { name: "Everything left" })).toContainText(`${GROUPS * 2} transactions`);
    await expect(sheet.getByRole("combobox", { name: /^Category for Shop/ })).toHaveCount(GROUPS);

    await sheet.getByRole("combobox", { name: "Category for everything left" }).fill("Everything else");
    await sheet.getByRole("button", { name: `Apply to all ${GROUPS * 2}` }).click();
    await expect(sheet.getByRole("status").filter({ hasText: "2 categorized as Everything else" })).toHaveCount(GROUPS, { timeout: 120_000 });
    expect(await categories()).toEqual([{ name: "Everything else", count: GROUPS * 2 }]);

    await sheet.getByRole("button", { name: "Change" }).first().click();
    await sheet.getByRole("combobox", { name: /^Category for Shop/ }).fill("Treats");
    await sheet.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(async () => (await categories()).find(row => row.name === "Treats")?.count, { timeout: 30_000 }).toBe(2);
    expect((await categories()).find(row => row.name === "Everything else")?.count).toBe(GROUPS * 2 - 2);
  } finally {
    await context.close();
    await deleteDisposableUser(db, user);
    await db.end();
  }
});
