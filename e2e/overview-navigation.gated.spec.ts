import { test, expect } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());
if (state) test.use({ storageState: state });

test("returning to Overview reuses the visited page", async ({ page }) => {
  const start = Date.now();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  console.log(`Overview direct load: ${Date.now() - start}ms`);
  await page.getByRole("link", { name: "Accounts", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
  const requests: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/" && request.headers()["rsc"] === "1") requests.push(url.pathname);
  });
  const back = Date.now();
  // Dispatch directly so hover prefetch cannot hide an unnecessary server render.
  await page.getByRole("link", { name: "Overview", exact: true }).first().dispatchEvent("click", { button: 0 });
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  console.log(`Overview return: ${Date.now() - back}ms; server requests: ${requests.length}`);
  expect(requests).toHaveLength(0);
});
