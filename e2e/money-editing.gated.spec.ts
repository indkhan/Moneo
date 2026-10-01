import { test, expect } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());

test("manual exact entries, reviewed bulk tags, batch undo and manual source restore", async ({ page }) => {
  test.setTimeout(120_000);
  const suffix = crypto.randomUUID().slice(0, 8);
  const account = `Manual QA ${suffix}`;
  const descriptions = [`Manual lunch ${suffix}`, `Manual train ${suffix}`];
  await page.goto("/");
  await page.getByLabel("Account name", { exact: true }).fill(account);
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await expect(page.getByRole("heading", { name: account })).toBeVisible();
  await page.goto("/money/transactions");
  for (const [index, description] of descriptions.entries()) {
    await page.getByText("Add a manual transaction", { exact: true }).click();
    const manual = page.locator("form").filter({ has: page.getByRole("button", { name: "Add transaction", exact: true }) });
    await manual.getByLabel("Account", { exact: true }).selectOption({ label: `${account} (EUR)` });
    await manual.getByLabel("Description", { exact: true }).fill(description);
    await manual.getByLabel("Signed decimal amount").fill(index ? "-20.00" : "-12.34");
    await manual.getByRole("button", { name: "Add transaction", exact: true }).click();
    const detail = page.getByRole("complementary", { name: "Transaction details" });
    await expect(detail.getByRole("heading", { name: description, exact: true })).toBeVisible();
    await expect(detail.getByText(index ? "-2000 minor units EUR" : "-1234 minor units EUR", { exact: false })).toBeVisible();
    await expect(detail.locator("pre").first()).toContainText('"type": "manual"');
    await detail.getByRole("link", { name: "Close", exact: true }).click();
  }
  await page.getByText("Bulk categories, tags and spending groups", { exact: true }).click();
  const bulk = page.locator("details").filter({ has: page.getByText("Bulk categories, tags and spending groups", { exact: true }) });
  for (const description of descriptions) await bulk.getByLabel(description, { exact: false }).check();
  await bulk.getByLabel("Change", { exact: true }).selectOption("tags");
  await bulk.getByLabel("Tags, separated by commas").fill(`qa-${suffix}`);
  await bulk.getByRole("button", { name: "Preview changes", exact: true }).click();
  await expect(bulk.getByRole("region", { name: "Bulk impact preview" })).toContainText("2 selected transactions");
  await bulk.getByRole("button", { name: "Apply to 2 transactions", exact: true }).click();
  await page.getByLabel("Filter by tag").fill(`qa-${suffix}`);
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  for (const description of descriptions) await expect(page.getByRole("link", { name: description, exact: true })).toBeVisible();
  await page.getByText("Manual entries and batch history", { exact: true }).click();
  await page.getByRole("button", { name: "Undo batch", exact: true }).first().click();
  await expect(page.getByRole("link", { name: descriptions[0], exact: true })).toHaveCount(0);
  await page.goto("/money/transactions");
  // A fresh untouched entry proves safe creation undo/restore independently of edited evidence.
  const untouched = `Manual restore ${suffix}`;
  await page.getByText("Add a manual transaction", { exact: true }).click();
  const manual = page.locator("form").filter({ has: page.getByRole("button", { name: "Add transaction", exact: true }) });
  await manual.getByLabel("Account", { exact: true }).selectOption({ label: `${account} (EUR)` });
  await manual.getByLabel("Description", { exact: true }).fill(untouched);
  await manual.getByLabel("Signed decimal amount").fill("-1.00");
  await manual.getByRole("button", { name: "Add transaction", exact: true }).click();
  const originalUrl = page.url();
  await page.getByRole("complementary", { name: "Transaction details" }).getByRole("link", { name: "Close", exact: true }).click();
  await page.getByText("Manual entries and batch history", { exact: true }).click();
  await page.getByRole("button", { name: "Undo manual entry", exact: true }).first().click();
  await expect(page.getByRole("link", { name: untouched, exact: true })).toHaveCount(0);
  await page.getByText("Manual entries and batch history", { exact: true }).click();
  await page.getByRole("button", { name: "Restore manual entry", exact: true }).first().click();
  await expect(page).toHaveURL(originalUrl);
});
