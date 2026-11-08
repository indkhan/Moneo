import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";

test.skip(!existsSync("e2e/.auth.json"), "needs the QA session");
test.use({ storageState: "e2e/.auth.json" });

test("syncs on opening Moneo and on returning to it, without blocking the page", async ({ page }) => {
  const opened = page.waitForResponse(response => response.url().endsWith("/api/sync/open"));
  await page.goto("/");
  expect((await opened).status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();

  const returned = page.waitForResponse(response => response.url().endsWith("/api/sync/open"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  expect((await returned).status()).toBe(200);
});
