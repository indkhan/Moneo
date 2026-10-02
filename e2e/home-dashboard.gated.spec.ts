import { test, expect } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());

test("Home remembers hidden and reordered built-in widgets", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Customize Home", { exact: true }).click();
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Save dashboard", exact: true }) });
  await form.getByRole("checkbox", { name: "Net worth and ledger", exact: true }).uncheck();
  await form.locator('input[name="position:accounts"]').fill("1");
  await form.locator('input[name="position:planning"]').fill("2");
  await form.getByRole("button", { name: "Save dashboard", exact: true }).click();
  await expect(page.getByRole("region", { name: "Overview", exact: true })).toHaveCount(0, { timeout: 30_000 });
  await page.reload();
  await expect(page.getByRole("region", { name: "Overview", exact: true })).toHaveCount(0);
  const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
  expect(headings.indexOf("Accounts")).toBeLessThan(headings.indexOf("Available to spend"));
  await page.getByText("Customize Home", { exact: true }).click();
  await form.getByRole("checkbox", { name: "Net worth and ledger", exact: true }).check();
  await form.getByRole("button", { name: "Save dashboard", exact: true }).click();
  await expect(page.getByRole("region", { name: "Overview", exact: true })).toBeVisible({ timeout: 30_000 });
});
