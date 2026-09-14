import { test, expect } from "@playwright/test";

test("URL filters, saved views and all-matching bulk selection share the same criteria", async ({
  page,
}) => {
  const saved: Array<Record<string, unknown>> = [];
  let selection: { filter?: Record<string, unknown> } = {};
  await page.route("**/api/v1/accounts", (r) => r.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/categories", (r) => r.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/transaction-views", async (r) => {
    if (r.request().method() === "POST") saved.push({ ...r.request().postDataJSON(), id: "view1" });
    await r.fulfill({ json: r.request().method() === "POST" ? saved[0] : { items: saved } });
  });
  await page.route("**/api/v1/transactions/search?**", (r) =>
    r.fulfill({
      json: {
        items: [
          {
            id: "tx1",
            accountId: "a1",
            description: "Restaurant",
            amountMinor: "1234",
            currencyCode: "EUR",
            direction: "debit",
            effectiveDate: "2026-08-03",
            version: "1",
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route("**/api/v1/transactions/selections", async (r) => {
    selection = r.request().postDataJSON();
    await r.fulfill({ json: { id: "selection1", count: 125, expiresAt: "2026-09-30T00:00:00Z" } });
  });
  await page.route("**/api/v1/commands/*", (r) =>
    r.fulfill({ json: { result: { applied: 124, replayed: 0, conflicts: ["tx1"], missing: [] } } }),
  );
  await page.goto("/money/transactions?q=Restaurant&dateFrom=2026-08-01&dateTo=2026-08-31");
  const main = page.locator("main");
  await expect(main.getByLabel("From", { exact: true })).toHaveValue("2026-08-01");
  await expect(main.getByRole("columnheader", { name: "Amount", exact: true })).toBeVisible();
  await main.getByRole("combobox", { name: "Direction", exact: true }).selectOption("debit");
  await main.getByLabel("Save view", { exact: true }).fill("August restaurants");
  await main.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(
    main
      .getByRole("combobox", { name: "Saved views", exact: true })
      .getByRole("option", { name: "August restaurants" }),
  ).toBeAttached();
  await main.getByRole("combobox", { name: "Direction", exact: true }).selectOption("credit");
  await main.getByRole("combobox", { name: "Saved views", exact: true }).selectOption("view1");
  await expect(main.getByRole("combobox", { name: "Direction", exact: true })).toHaveValue("debit");
  await main.getByRole("button", { name: "Select all matching results" }).click();
  await expect(main.getByRole("status")).toHaveText("125 matching rows frozen.");
  expect(selection.filter).toEqual({
    q: "Restaurant",
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    directions: ["debit"],
  });
  await main.getByRole("button", { name: "Exclude selected from analytics" }).click();
  await expect(main.getByRole("status")).toContainText(
    "124 updated; 0 already applied; 1 stale rows skipped",
  );
  await page.screenshot({ path: "test-results/transaction-workspace.png", fullPage: true });
});
