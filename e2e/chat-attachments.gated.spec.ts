import ExcelJS from "exceljs";
import { test, expect } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());

// The model is stubbed; upload, type sniffing, storage and the cited-section viewer are real.
test("a spreadsheet answer cites a cell that opens on its place in the file", async ({ page }) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Budget");
  sheet.addRows([["Item", "Amount"], ["Rent", 950], ["Power", 60]]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  let submitted: { attachments?: { path: string; name: string }[] } | undefined;
  await page.route("**/api/chat", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON();
    if (body?.attachments) submitted = body;
    const id = submitted?.attachments?.[0]?.path.slice(37, 45) ?? "00000000";
    await route.fulfill({ json: { conversationId: crypto.randomUUID(), answer: `Power costs 60 a month. {{cite ${id} Budget!B3 "60"}} Rent is the biggest item. {{cite ffffffff Budget!B2}}`, toolsUsed: [], followUps: [] } });
  });

  await page.goto("/ai?conversation=new");
  const main = page.locator("main");
  await main.locator('input[type="file"]').setInputFiles({ name: "budget.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
  await expect(main.getByRole("button", { name: "Remove budget.xlsx" })).toBeVisible();
  await expect(main.getByLabel("Uploading")).toHaveCount(0, { timeout: 15_000 });
  await main.getByLabel("Ask about your finances").fill("What does power cost?");
  await main.getByRole("button", { name: "Send", exact: true }).click();

  // Only the file in this conversation becomes a chip.
  const chip = main.getByRole("button", { name: "budget.xlsx · Budget!B3" });
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(main.getByText("ffffffff")).toHaveCount(0);
  expect(submitted?.attachments?.[0].name).toBe("budget.xlsx");

  await chip.click();
  const viewer = page.getByRole("dialog", { name: "budget.xlsx · Budget!B3" });
  await expect(viewer.locator("td[data-target]")).toHaveText("60");
  await expect(viewer.getByRole("rowheader", { name: "2" })).toBeVisible();
  await viewer.getByRole("button", { name: "Close" }).click();
  await expect(viewer).toHaveCount(0);
});
