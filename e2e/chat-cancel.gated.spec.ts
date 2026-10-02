import { test, expect } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());

for (const panel of [false, true]) {
  test(`cancel ${panel ? "contextual panel" : "conversation"} without displaying late work`, async ({ page }) => {
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    let submitted: { requestId: string } | undefined;
    await page.route("**/api/chat", async route => {
      if (route.request().method() === "PATCH") {
        expect(route.request().postDataJSON().requestId).toBe(submitted?.requestId);
        await route.fulfill({ json: { status: "canceled" } });
      } else {
        submitted = route.request().postDataJSON();
        await paused;
        await route.fulfill({ json: { answer: "Late answer must stay hidden" } }).catch(() => {});
      }
    });
    await page.goto("/ai?conversation=new");
    if (panel) await page.getByRole("button", { name: "Ask Moneo" }).click();
    const scope = panel ? page.getByRole("dialog", { name: "AI assistant" }) : page.locator("main");
    await scope.getByLabel(panel ? "Question" : "Ask about your finances").fill("What changed this month?");
    await scope.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => submitted?.requestId).toBeTruthy();
    await scope.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(scope.getByRole("status")).toContainText("Canceled");
    release();
    await expect(scope.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expect(page.getByText("Late answer must stay hidden")).toHaveCount(0);
  });
}
