import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const statePath = e2eStorageStatePath();
function session(cookies: { name: string; value: string }[]) {
  const raw = cookies.filter(cookie => cookie.name.includes("-auth-token")).sort((a, b) => a.name.localeCompare(b.name)).map(cookie => cookie.value).join("");
  return JSON.parse(raw.startsWith("base64-") ? Buffer.from(raw.slice(7), "base64url").toString() : raw);
}
function expired(accessToken: string) {
  return JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString()).exp < Date.now() / 1000;
}
const stored = statePath ? session(JSON.parse(readFileSync(statePath, "utf8")).cookies) : null;
test.skip(!hasSupabaseEnv() || !statePath, gatedSkipReason());
if (statePath) test.use({ storageState: statePath });

test("real session persists across rendering and API requests, refreshing an expired session", async ({ page, context }) => {
  await page.goto("/money/accounts");
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
  const refreshed = session(await context.cookies());
  // Compare booleans so a failing assertion never prints session material.
  if (expired(stored.access_token)) expect(refreshed.access_token !== stored.access_token).toBe(true);
  expect(expired(refreshed.access_token)).toBe(false);
  expect((await context.request.get(`/api/analysis/${crypto.randomUUID()}`)).status()).toBe(404);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await context.storageState({ path: statePath! });
});
