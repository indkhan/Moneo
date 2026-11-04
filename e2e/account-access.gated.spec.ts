import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { deleteDisposableUser } from "./fixtures";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL, "Requires disposable Supabase auth and database fixtures");

test("a signed-out link returns after sign-in, sign out ends the session, and Delete account removes the user", async ({ page }) => {
  test.setTimeout(180_000);
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `qa-access-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "account-access" } });
  expect(created.error).toBeNull();
  const user = created.data.user!.id;
  const signIn = async () => {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  };
  try {
    await page.goto("/money/accounts?from=link");
    await expect(page).toHaveURL(/\/login\?next=/);
    await signIn();
    await expect(page).toHaveURL(/\/money\/accounts\?from=link$/);

    await page.goto("/settings");
    await page.locator("#account").getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);

    await signIn();
    await expect(page).toHaveURL(/\/settings$/);
    const section = page.getByRole("region", { name: "Delete account" });
    await expect(section.getByRole("button", { name: "Delete account", exact: true })).toBeDisabled();
    await section.getByLabel("Type DELETE to confirm").fill("DELETE");
    await section.getByRole("button", { name: "Delete account", exact: true }).click();
    await expect(page).toHaveURL(/\/login\?deleted=1$/);
    await expect(page.getByText("Your account and data were deleted.", { exact: true })).toBeVisible();
    expect((await db`select count(*)::int as count from auth.users where id=${user}`)[0].count).toBe(0);
    expect((await db`select count(*)::int as count from public.workspaces where owner_id=${user}`)[0].count).toBe(0);
  } finally {
    if ((await db`select count(*)::int as count from auth.users where id=${user}`)[0].count) await deleteDisposableUser(db, user);
    await db.end();
  }
});
