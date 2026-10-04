import { expect, test } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());

test("Evidence room handles rich replies, artifacts, cancellation and modal keyboard behavior", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("console", message => { if (/hydrat/i.test(message.text())) hydrationErrors.push(message.text()); });
  const base = process.env.E2E_BASE_URL ?? "http://localhost:3000";
  const conversation = process.env.E2E_AI_CONVERSATION;
  await page.goto(`${base}/ai${conversation ? `?conversation=${conversation}` : ""}`);
  await expect(page.getByRole("heading", { name: "Every answer has a trail." })).toBeVisible();
  expect(await page.locator("main").evaluate(element => getComputedStyle(element).getPropertyValue("--color-background").trim())).toBe("#182333");
  await page.getByRole("button", { name: "Ask Moneo", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "AI assistant" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close AI assistant" })).toBeFocused();
  const reply = '## Finance lookup\n\n**EUR 420**\n\n| Category | Amount |\n| --- | --- |\n| Dining | EUR 420 |\n\n```sql\nSELECT amount_minor FROM transactions;\n```\n\n[Source](https://example.com/evidence)\n\n/ai/library/00000000-0000-4000-8000-000000000001';
  await page.route("**/api/chat", route => route.fulfill({ json: { answer: reply, toolsUsed: ["transactions_search", "analytics_cashflow"] } }));
  await dialog.getByLabel("Question", { exact: true }).fill("Find my dining transactions");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Finance lookup" })).toBeVisible();
  await expect(dialog.locator("table")).toContainText("Dining");
  await expect(dialog.locator("code.language-sql")).toContainText("SELECT amount_minor");
  await expect(dialog.getByRole("link", { name: /Open saved tool/ })).toHaveAttribute("href", /\/ai\/library\//);
  await dialog.getByText("Completed tools · 2", { exact: true }).click();
  await expect(dialog.getByRole("listitem").filter({ hasText: "Search transactions" })).toBeVisible();
  await page.screenshot({ path: ".qa/evidence-room-panel-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 360, height: 780 });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: ".qa/evidence-room-panel-mobile.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Ask Moneo", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".qa/evidence-room-page-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: ".qa/evidence-room-page-desktop.png", fullPage: true });
  if (conversation) {
    const artifact = page.locator("main").getByRole("link", { name: /Open saved tool/ });
    await expect(artifact).toBeVisible();
    await artifact.click();
    await expect(page).toHaveURL(/\/ai\/library\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "QA spending explorer", exact: true })).toBeVisible();
    await page.goto(`${base}/ai?conversation=${conversation}`);
  }
  await page.getByRole("button", { name: "Ask Moneo", exact: true }).click();
  await page.unroute("**/api/chat");
  await page.route("**/api/chat", async route => {
    if (route.request().method() === "PATCH") return route.fulfill({ json: { status: "canceled" } });
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.fulfill({ json: { answer: "Late answer" } }).catch(() => {});
  });
  await dialog.getByLabel("Question", { exact: true }).fill("Review my spending");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(dialog.getByText("Request running · waiting for response")).toBeVisible();
  await dialog.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(dialog.getByText(/Canceled. Completed edits remain/)).toBeVisible();
  await expect(dialog.getByText("Late answer")).toHaveCount(0);
  expect(hydrationErrors).toEqual([]);
});
