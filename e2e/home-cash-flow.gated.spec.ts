import { test, expect, type Request } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());

test("Home switches cash-flow In/Out in the browser and keeps the pick in the URL", async ({ page }) => {
  await page.goto("/");
  const panel = page.getByRole("region", { name: "Cash flow", exact: true });
  const show = panel.getByRole("group", { name: "Show" });
  await expect(show.getByRole("link", { name: "Both" })).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });

  // A navigation (not a prefetch) would re-render all of Home on the server.
  const navigations: string[] = [];
  const onRequest = (request: Request) => { if (request.headers()["rsc"] === "1" && !request.headers()["next-router-prefetch"]) navigations.push(request.url()); };
  page.on("request", onRequest);
  await show.getByRole("link", { name: "Out" }).click();
  await expect(page).toHaveURL(/[?&]show=out&flow=out#cash-flow$/);
  await expect(show.getByRole("link", { name: "Out" })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("heading", { name: /^Top categories in / })).toBeVisible();
  await show.getByRole("link", { name: "In" }).click();
  await expect(page).toHaveURL(/[?&]show=in&flow=in#cash-flow$/);
  await expect(panel.getByRole("heading", { name: /^Income by category in / })).toBeVisible();
  await expect(panel.getByRole("heading", { name: /^Top categories in / })).toHaveCount(0);
  await page.getByRole("region", { name: "Cash flow this month" }).getByRole("link", { name: /^Out/ }).click();
  await expect(page).toHaveURL(/[?&]flow=out/);
  await expect(panel.getByRole("heading", { name: /^Top merchants in / })).toBeVisible();
  page.off("request", onRequest);
  expect(navigations).toEqual([]);

  // History and a reload both restore the pick from the URL.
  await page.goBack();
  await expect(panel.getByRole("heading", { name: /^Income by category in / })).toBeVisible();
  await page.reload();
  await expect(show.getByRole("link", { name: "In" })).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await expect(panel.getByRole("heading", { name: /^Income by category in / })).toBeVisible();
});
