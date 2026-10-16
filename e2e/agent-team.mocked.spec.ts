import { expect, test } from "@playwright/test";

// The agent team starts when an import's rows are in; the completed import links to its live run.
// Mission control itself is server-rendered behind auth and covered by render tests.
test("a completed import links to its agent-team run", async ({ page }) => {
  const item = { id: "00000000-0000-4000-8000-000000000081", filename: "Synthetic agents.csv",
    status: "completed", run_version: 1, total_rows: 3, new_rows: 3, matched_rows: 0,
    review_rows: 0, rejected_rows: 0, error: null, created_at: "2026-10-16T10:00:00Z" };
  await page.route("**/api/imports", route => route.fulfill({ json: [item] }));
  await page.goto("/import");
  const history = page.getByRole("region", { name: "Import history" });
  await expect(history.getByRole("link", { name: "Watch the agent team" })).toHaveAttribute("href", `/ai/agents?import=${item.id}`);
});
