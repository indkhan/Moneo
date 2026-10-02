import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state || !fs.existsSync(state), gatedSkipReason());

test("import history failure stays visible until a successful reload", async ({ page }) => {
  let available = false;
  await page.route("**/api/imports", (route) => route.fulfill({ status: available ? 200 : 500,
    contentType: "application/json", body: available ? "[]" : '{"error":"Unavailable"}' }));
  await page.goto("/import");
  const error = page.getByRole("alert").filter({ hasText: "Import history is unavailable. Try again." });
  await expect(error).toBeVisible();
  await expect(page.getByText("No imports yet.")).toHaveCount(0);
  available = true;
  await page.getByRole("button", { name: "Reload history" }).click();
  await expect(error).toHaveCount(0);
  await expect(page.getByText("No imports yet.")).toBeVisible();
});
