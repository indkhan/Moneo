import { expect, test } from "@playwright/test";
import type { Route } from "@playwright/test";

for (const terminal of ["canceled", "completed"] as const) {
  test(`a delayed poll cannot replace ${terminal} status or its fresh counts`, async ({ page }) => {
    const id = "00000000-0000-4000-8000-000000000051";
    const initial = { id, filename: "Synthetic polling.csv", status: "running", run_version: 1,
      total_rows: 75, new_rows: 0, matched_rows: 0, review_rows: 0, classification_review_rows: 0,
      rejected_rows: 0, error: null, created_at: "2026-10-02T10:00:00Z" };
    let current = initial;
    let delayed: Route | undefined;
    let notifyPoll!: () => void;
    const pollStarted = new Promise<void>((resolve) => { notifyPoll = resolve; });
    let resumed = false;
    await page.route("**/api/imports", (route) => route.fulfill({ json: [current] }));
    await page.route(`**/api/imports/${id}`, async (route) => {
      if (!delayed) { delayed = route; notifyPoll(); return; }
      await route.fulfill({ json: resumed ? current : initial });
    });
    await page.route(`**/api/imports/${id}/control`, async (route) => {
      const { action } = route.request().postDataJSON();
      if (action === "resume") {
        resumed = true;
        current = { ...current, status: "queued", run_version: 3 };
      } else current = { ...current, status: terminal, run_version: terminal === "canceled" ? 2 : 1,
        new_rows: terminal === "canceled" ? 25 : 75 };
      await route.fulfill({ json: { importId: id, status: current.status, runVersion: current.run_version,
        totalRows: 75, started: terminal === "canceled" || resumed } });
    });
    await page.goto("/import");
    const history = page.getByRole("region", { name: "Import history" }).locator("article");
    await expect(history.getByRole("status")).toHaveText("running");
    await pollStarted;
    await history.getByRole("button", { name: "Stop import", exact: true }).click();
    await expect(history.getByRole("status")).toHaveText(terminal);
    const response = page.waitForResponse((item) => item.url().endsWith(`/api/imports/${id}`));
    await delayed!.fulfill({ json: initial });
    await (await response).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(history.getByRole("status")).toHaveText(terminal);
    await expect(history).toContainText(`${terminal === "canceled" ? 25 : 75} new`);
    if (terminal === "canceled") {
      await history.getByRole("button", { name: "Resume import", exact: true }).click();
      await expect(history.getByRole("status")).toHaveText("queued");
      await expect(history).toContainText("25 new");
    }
  });
}

test("a newer request with an older queued snapshot cannot regress running progress", async ({ page }) => {
  const id = "00000000-0000-4000-8000-000000000052";
  const queued = { id, filename: "Synthetic ordered polling.csv", status: "queued", run_version: 1,
    total_rows: 75, new_rows: 0, matched_rows: 0, review_rows: 0, rejected_rows: 0,
    error: null, created_at: "2026-10-02T10:00:00Z" };
  const polls: Route[] = [];
  let notifySecond!: () => void;
  const twoPolls = new Promise<void>((resolve) => { notifySecond = resolve; });
  await page.route("**/api/imports", (route) => route.fulfill({ json: [queued] }));
  await page.route(`**/api/imports/${id}`, async (route) => {
    polls.push(route);
    if (polls.length === 2) notifySecond();
    if (polls.length > 2) await route.fulfill({ json: queued });
  });
  await page.goto("/import");
  const history = page.getByRole("region", { name: "Import history" }).locator("article");
  await expect(history.getByRole("status")).toHaveText("queued");
  await twoPolls;
  await polls[0].fulfill({ json: { ...queued, status: "running", new_rows: 25 } });
  await expect(history.getByRole("status")).toHaveText("running");
  const stale = page.waitForResponse((response) => response.url().endsWith(`/api/imports/${id}`));
  await polls[1].fulfill({ json: queued });
  await (await stale).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(history.getByRole("status")).toHaveText("running");
  await expect(history).toContainText("25 new");
});
