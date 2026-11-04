import { expect, test } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());

for (const [path, text] of [
  ["/plan/spending?month=2026-13", "invalid month"],
  ["/money/organization?review=not-a-uuid", "out of date"],
  ["/money/organization?cursor=not-a-cursor", "out of date"],
  ["/money/investigations?from=not-a-date&to=2026-13-40", "a real date"],
] as const) test(`${path} recovers in place`, async ({ page }) => {
  await page.goto(path);
  await expect(page.locator("main").getByRole("alert").first()).toContainText(text);
  await expect(page.locator("body")).not.toContainText(/invalid_format|ZodError|This page couldn.t load|pattern/);
});

for (const path of ["/ai/activity/not-a-uuid", "/does-not-exist", "/ai/activity/00000000-0000-4000-8000-000000000000"]) test(`${path} offers a way back`, async ({ page }) => {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "This page isn’t here" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Overview" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("invalid input syntax");
});

test("a refused money form explains why beside the form and keeps what was typed", async ({ page }) => {
  await page.goto("/money/accounts");
  const form = page.locator("#own-accounts form").filter({ hasText: "Save owned IBAN" });
  await form.getByLabel("IBAN").fill("NOT-AN-IBAN");
  await form.getByLabel("Name").fill("Test bank");
  await form.getByRole("button", { name: "Save owned IBAN", exact: true }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(form.getByLabel("IBAN")).toHaveValue("NOT-AN-IBAN");
  await expect(page.getByRole("heading", { name: "This page couldn’t load" })).toHaveCount(0);
});

test("an unsent chat question survives switching to another chat", async ({ page }) => {
  await page.goto("/ai?conversation=new");
  const question = page.getByLabel("Ask about your finances");
  await question.fill("Half-written question");
  await page.goto("/settings");
  await page.goBack();
  await expect(question).toHaveValue("Half-written question");
});
