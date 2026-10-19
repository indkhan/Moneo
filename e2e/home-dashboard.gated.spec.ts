import { test, expect } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());

test("Settings customizes Home and remembers hidden and reordered widgets", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Customize Home", { exact: true })).toHaveCount(0);
  await page.goto("/settings");
  await page.locator("summary", { hasText: "Customize Home" }).click();
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Save dashboard", exact: true, includeHidden: true }) });
  await form.getByRole("checkbox", { name: "Overview", exact: true }).uncheck();
  await form.locator('input[name="position:accounts"]').fill("1");
  await form.locator('input[name="position:planning"]').fill("2");
  const version = Number(await form.locator('input[name="version"]').inputValue());
  await form.getByRole("button", { name: "Save dashboard", exact: true }).click();
  await expect(form.locator('input[name="version"]')).toHaveValue(String(version + 1), { timeout: 30_000 });
  await expect(page).toHaveURL(/\/settings$/, { timeout: 30_000 });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Overview", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("region", { name: "Overview", exact: true })).toHaveCount(0);
  // Accounts was moved to position 1, so it is now the first Home widget.
  await expect(page.locator("main section").first()).toHaveAttribute("aria-labelledby", "home-accounts");
  await page.goto("/settings");
  await page.locator("summary", { hasText: "Customize Home" }).click();
  await form.getByRole("checkbox", { name: "Overview", exact: true }).check();
  const restoredVersion = Number(await form.locator('input[name="version"]').inputValue());
  await form.getByRole("button", { name: "Save dashboard", exact: true }).click();
  await expect(form.locator('input[name="version"]')).toHaveValue(String(restoredVersion + 1), { timeout: 30_000 });
  await expect(page).toHaveURL(/\/settings$/, { timeout: 30_000 });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Overview", exact: true })).toBeVisible({ timeout: 30_000 });
});
