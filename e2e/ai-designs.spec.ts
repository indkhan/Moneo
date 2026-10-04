import { expect, test } from "@playwright/test";

test("design pairs can be compared, tried, and selected on desktop and mobile", async ({ page }) => {
  await page.goto("http://127.0.0.1:3000/ai-designs.html");
  for (const name of ["Quiet conversation", "Financial briefing", "Working canvas", "Evidence room"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.getByLabel("AI page preview")).toBeVisible();
    await expect(page.getByLabel("Ask Moneo preview")).toBeVisible();
    for (const example of ["Markdown answer", "SQL / code", "Web search", "Finance lookup", "Tool → artifact"]) {
      await page.getByRole("button", { name: example, exact: true }).click();
      await expect(page.getByLabel("Ask Moneo preview").locator(".answer")).not.toBeEmpty();
    }
    await page.getByLabel("Ask Moneo preview").getByRole("button", { name: "Open chart ↗" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await page.getByLabel("Ask Moneo question").fill("<img src=x onerror=alert(1)>");
  await page.getByRole("button", { name: "Send panel question" }).click();
  await expect(page.getByLabel("Ask Moneo preview").getByText("<img src=x onerror=alert(1)>", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Ask Moneo preview").locator("img")).toHaveCount(0);
  await page.getByRole("button", { name: "Choose this pair" }).click();
  await expect(page.getByRole("status")).toContainText("Evidence room");
  await page.reload();
  await expect(page.getByRole("status")).toContainText("Evidence room");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ["Quiet conversation", "Financial briefing", "Working canvas", "Evidence room"]) {
    await page.getByRole("button", { name, exact: true }).click();
    for (const example of ["Empty state", "Markdown answer", "SQL / code", "Web search", "Finance lookup", "Tool → artifact", "Running / stopped / error"]) {
      await page.getByRole("button", { name: example, exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  const panel = page.getByLabel("Ask Moneo preview");
  await panel.getByRole("button", { name: "Stop generation" }).click();
  await expect(panel.locator(".state")).toHaveText("Stopped");
  await page.getByRole("button", { name: "Running / stopped / error", exact: true }).click();
  await panel.getByRole("button", { name: "Show tool error" }).click();
  await expect(panel.locator(".state")).toHaveText("Failed");
  await panel.getByRole("button", { name: "Retry chart" }).click();
  await expect(panel.getByRole("button", { name: "Open chart ↗" })).toBeVisible();
});
