import { expect, test } from "@playwright/test";

test("restored import progress hydrates without replacing the server tree", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("pageerror", (error) => {
    if (error.message.includes("Hydration failed")) hydrationErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.text().includes("Hydration failed")) hydrationErrors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      "moneo.importWizard.v1",
      JSON.stringify({
        version: 1,
        step: "summary",
        importId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        fileName: "statement.csv",
        jobId: "job-1",
      }),
    );
  });

  await page.goto("/money/import");
  await expect(page.getByRole("heading", { name: "Import queued" })).toBeVisible();
  expect(hydrationErrors).toEqual([]);
});
