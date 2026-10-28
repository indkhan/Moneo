import { test, expect } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());

test("Settings hides Home widgets and dragging a card reorders Home", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Customize Home", { exact: true })).toHaveCount(0);
  await page.goto("/settings");
  await page.locator("summary", { hasText: "Customize Home" }).click();
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Save dashboard", exact: true, includeHidden: true }) });
  await form.getByRole("checkbox", { name: "Overview", exact: true }).uncheck();
  const version = Number(await form.locator('input[name="version"]').inputValue());
  await form.getByRole("button", { name: "Save dashboard", exact: true }).click();
  await expect(form.locator('input[name="version"]')).toHaveValue(String(version + 1), { timeout: 30_000 });
  await expect(page).toHaveURL(/\/settings$/, { timeout: 30_000 });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Overview", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("region", { name: "Overview", exact: true })).toHaveCount(0);
  // Drag Accounts onto the first card; the new order survives a reload.
  await page.waitForLoadState("networkidle"); // dragging needs the hydrated page
  const handles = page.getByRole("button", { name: /^Move / });
  const firstName = await handles.first().getAttribute("aria-label");
  const accounts = page.getByRole("button", { name: "Move Accounts", exact: true });
  const target = await page.locator("main .grid > div").first().boundingBox();
  await accounts.hover();
  await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect(handles.first()).toHaveAttribute("aria-label", "Move Accounts");
  expect(firstName).not.toBe("Move Accounts");
  await expect.poll(async () => { await page.reload(); return page.getByRole("button", { name: /^Move / }).first().getAttribute("aria-label"); }, { timeout: 30_000 }).toBe("Move Accounts");
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
