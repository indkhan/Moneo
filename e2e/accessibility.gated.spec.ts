import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state || !process.env.SUPABASE_SERVICE_ROLE_KEY, gatedSkipReason());

test("core screens fit mobile and the contextual assistant supports keyboard dismissal", async ({ page }) => {
  test.setTimeout(120_000);
  const cookies = JSON.parse(readFileSync(state!, "utf8")).cookies;
  const db = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => cookies, setAll: () => {} } });
  const cleanup = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user }, error: authError } = await db.auth.getUser();
  expect(authError).toBeNull(); expect(user).not.toBeNull();
  const { data: workspace, error: workspaceError } = await db.from("workspaces").select("id").eq("owner_id", user!.id).single();
  expect(workspaceError).toBeNull();
  const accountId = randomUUID(), accountName = `Synthetic mobile ${"W".repeat(90)}`;
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/settings");
  const appearance = page.getByRole("combobox", { name: "Appearance", exact: true });
  const originalTheme = await appearance.inputValue();
  await appearance.selectOption("dark");
  await page.getByRole("button", { name: "Save preferences", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Preferences saved");
  try {
  expect((await db.from("accounts").insert({ id: accountId, workspace_id: workspace!.id, name: accountName, currency_code: "EUR", type: "checking" })).error).toBeNull();
  for (const route of ["/", "/money/transactions", "/money/accounts", "/money/wealth", "/import", "/settings", "/ai", "/ai/library"]) {
    await page.goto(route);
    await expect(page).not.toHaveURL(/login/);
    await expect(page.locator("h1").first()).toBeVisible();
    if (route === "/") await expect(page.locator("article").filter({ has: page.getByRole("heading", { name: accountName, exact: true }) })).toBeVisible();
    const overflow = await page.evaluate(() => [...document.querySelectorAll("main *")].filter(element => element.getBoundingClientRect().right > innerWidth)
      .map(element => ({ tag: element.tagName, class: element.className, right: Math.round(element.getBoundingClientRect().right) })).slice(0, 15));
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route}: ${JSON.stringify(overflow)}`).toBe(true);
    await expect(page.locator("h1").first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
  }
  await page.getByRole("button", { name: "Ask Moneo", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "AI assistant" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Close AI assistant" })).toBeFocused();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    // Native dialogs may cycle through browser chrome (body is the reported active element).
    expect(await dialog.evaluate(element => element.contains(document.activeElement) || document.activeElement === document.body)).toBe(true);
  }
  await page.getByRole("button", { name: "Close AI assistant" }).focus();
  await page.locator('nav[aria-label="Main mobile"] a').first().evaluate(element => (element as HTMLElement).focus());
  await expect(page.getByRole("button", { name: "Close AI assistant" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Ask Moneo", exact: true })).toBeFocused();
  await page.screenshot({ path: ".qa/library-mobile-dark.png", fullPage: true });
  } finally {
    try {
    await page.goto("/settings");
    await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption(originalTheme);
    await page.getByRole("button", { name: "Save preferences", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Preferences saved");
    } finally {
      expect((await cleanup.from("accounts").delete().eq("id", accountId).eq("workspace_id", workspace!.id)).error).toBeNull();
    }
  }
});
