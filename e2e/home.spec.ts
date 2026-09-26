import { test, expect } from "@playwright/test";

test("home renders stack status", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Personal Finance Workspace")).toBeVisible();
});
