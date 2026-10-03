import { expect, test } from "@playwright/test";

test("undo removes an import from history immediately and after reload", async ({ page }) => {
  const item = { id: "00000000-0000-4000-8000-000000000053", filename: "Synthetic undo.csv",
    status: "completed", run_version: 1, total_rows: 1, new_rows: 1, matched_rows: 0,
    review_rows: 0, rejected_rows: 0, error: null, created_at: "2026-10-03T10:00:00Z" };
  let undone = false;
  await page.route("**/api/imports", route => route.fulfill({ json: undone ? [] : [item] }));
  await page.route(`**/api/imports/${item.id}/undo`, async route => {
    if (route.request().method() === "POST") {
      undone = true;
      await route.fulfill({ json: { import_id: item.id, status: "undone" } });
    } else await route.fulfill({ json: { import_id: item.id, filename: item.filename,
      status: item.status, deletable_transactions: 1, deletable_balances: 0, blockers: [], safe: true } });
  });
  await page.goto("/import");
  const history = page.getByRole("region", { name: "Import history" });
  await history.getByRole("button", { name: "Undo import", exact: true }).click();
  await history.getByRole("button", { name: "Confirm undo 1 transactions", exact: true }).click();
  await expect(history.getByText(item.filename)).toHaveCount(0);
  await expect(history.getByText("No imports yet.")).toBeVisible();
  await page.reload();
  await expect(history.getByText(item.filename)).toHaveCount(0);
  await expect(history.getByText("No imports yet.")).toBeVisible();
});
