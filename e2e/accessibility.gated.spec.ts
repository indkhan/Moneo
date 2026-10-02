import { expect, test } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());

test("core screens fit mobile and the contextual assistant supports keyboard dismissal", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/settings");
  const appearance = page.getByRole("combobox", { name: "Appearance", exact: true });
  const originalTheme = await appearance.inputValue();
  await appearance.selectOption("dark");
  await page.getByRole("button", { name: "Save preferences", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Preferences saved");
  try {
  for (const route of ["/", "/money/transactions", "/money/accounts", "/money/wealth", "/import", "/settings", "/ai", "/ai/library"]) {
    await page.goto(route);
    await expect(page).not.toHaveURL(/login/);
    await expect(page.locator("h1").first()).toBeVisible();
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
    await page.goto("/settings");
    await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption(originalTheme);
    await page.getByRole("button", { name: "Save preferences", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Preferences saved");
  }
});
