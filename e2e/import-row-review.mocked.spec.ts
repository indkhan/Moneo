import { test, expect } from "@playwright/test";
import { mockInspectResponse } from "./fixtures";

test("reviews a corrected observation and explicit exclusion before confirmation", async ({ page }) => {
  let inspected = false;
  let confirmed = false;
  await page.route("**/api/imports", route => route.fulfill({ json: [] }));
  await page.route("**/api/imports/inspect", route => {
    const response = mockInspectResponse();
    const body = route.request().postData() ?? "";
    inspected = body.includes('"rowNumber":3') && body.includes('"action":"correct"') && body.includes('"action":"exclude"') && body.includes('"Description":"Second"') && body.includes('"Amount":"2"');
    return route.fulfill({ json: { ...response, headers: ["Date", "Description", "Amount"], mapping: { ...response.mapping, dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", ...(inspected ? { rowDecisions: [
      { rowNumber: 3, action: "correct", values: { Date: "2026-09-02" } },
      { rowNumber: 4, action: "exclude", reason: "Statement footer" },
    ] } : {}) }, preview: { ...response.preview,
      totalRows: 3, acceptedRows: inspected ? 2 : 1, correctedRows: inspected ? 1 : 0,
      excludedRows: inspected ? [{ rowNumber: 4, sourceRow: { Date: "", Description: "Total", Amount: "3" }, reason: "Statement footer" }] : [],
      unresolvedRows: inspected ? [] : [
        { rowNumber: 3, message: "Row 3: CSV field mismatch", sourceRow: { Date: "bad", Description: "Second", Amount: "2", __moneo_csv_issue: "TooFewFields" } },
        { rowNumber: 4, message: "Row 4: Invalid date", sourceRow: { Date: "", Description: "Total", Amount: "3" } },
      ],
    } } });
  });
  await page.route("**/api/imports/confirm", async route => { confirmed = true; await route.fulfill({ json: { importId: "reviewed", status: "queued" } }); });
  await page.goto("/import");
  await expect(page.getByLabel("Financial statement files")).toBeEnabled();
  await page.getByLabel("Financial statement files").setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from("Date,Description,Amount\n2026-09-01,First,1\nbad,Second,2\n,Total,3") });
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await page.getByLabel("Source row 3 Date").fill("2026-09-02");
  await page.getByRole("button", { name: "Use correction for row 3" }).click();
  await page.getByLabel("Exclusion reason for row 4").fill("Statement footer");
  await page.getByRole("button", { name: "Exclude row 4" }).click();
  await page.getByRole("button", { name: "Preview correction" }).click();
  await expect(page.getByText("2 accepted · 1 corrected · 1 excluded · 0 unresolved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await page.getByLabel("I reviewed the corrections and exclusions against the original source.").check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  expect(inspected).toBe(true);
  expect(confirmed).toBe(true);
});
