import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("competitor concept supports research, review, scenarios, and mobile", async ({ page }) => {
  await page.goto(pathToFileURL(resolve("public/competitor-features.html")).href);
  await expect(page.getByRole("heading", { name: "Your money, in perspective." })).toBeVisible();
  await page.screenshot({ path: "test-results/competitor-concept-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Customize home" }).click();
  await page.getByLabel("Spending pace", { exact: true }).uncheck();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-widget="pace"]')).toBeHidden();
  await page.getByRole("button", { name: "Customize home" }).click();
  await page.getByLabel("Spending pace", { exact: true }).check();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Competitor research", exact: true }).click();
  await expect(page.locator(".competitor-card")).toHaveCount(8);
  await page.getByLabel("Search competitors and features").fill("multi-currency");
  await expect(page.locator(".competitor-card:visible")).toHaveCount(2);
  await page.getByLabel("Search competitors and features").fill("");
  await page.getByRole("button", { name: "Enlarge Copilot UI" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  for (const image of await page.locator(".competitor-card img").all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
    expect(await image.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const container = node.parentElement!.getBoundingClientRect();
      return bounds.bottom <= container.bottom && bounds.right <= container.right;
    })).toBe(true);
  }
  await page.screenshot({ path: "test-results/competitor-research.png", fullPage: true });
  await page.getByRole("button", { name: "Money", exact: true }).click();
  await page.getByLabel("Search demo transactions").fill("Rewe");
  await expect(page.locator("#transaction-body tr:visible")).toHaveCount(1);
  await page.getByLabel("Search demo transactions").fill("");
  await page.getByRole("button", { name: "Review Amazon transaction" }).click();
  await expect(page.getByRole("status")).toContainText("Reviewed");
  await page.getByRole("button", { name: "Undo review" }).click();
  await expect(page.getByRole("button", { name: "Review Amazon transaction" })).toBeVisible();
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  const before = await page.locator("#forecast-value").textContent();
  await page.getByLabel("Extra monthly savings").fill("300");
  await expect(page.locator("#forecast-value")).not.toHaveText(before!);
  await expect(page.locator("#forecast-value")).toContainText("35,400");
  await page.getByRole("button", { name: "By category", exact: true }).click();
  await expect(page.locator("#budget-preview")).toContainText("Groceries");
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await page.getByRole("button", { name: "Show evidence" }).click();
  await expect(page.getByRole("dialog")).toContainText("Fictional source records");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Pin to home", exact: true }).click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.locator("#pinned-tool")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ["Home", "Money", "Plan", "AI", "Competitor research", "Feature library"]) {
    await page.getByRole("button", { name, exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.screenshot({ path: "test-results/competitor-concept-mobile.png", fullPage: true });
});
