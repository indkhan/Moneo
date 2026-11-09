// Runtime budgets for Home, where #124 (voice) shipped 68 background requests in 12 s, polling in
// a hidden tab and layout shift. The page's clock is fake, so a minute of timers runs instantly
// and the counts don't depend on the machine.
import { expect, test, type Page } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

test.skip(!hasSupabaseEnv() || !e2eStorageStatePath(), gatedSkipReason());

async function openHome(page: Page) {
  await page.clock.install();
  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver(list => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[])
        if (!entry.hadRecentInput) (window as unknown as { __cls: number }).__cls += entry.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto("/");
  await expect(page.locator("main h1").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
}

function countRequests(page: Page) {
  const urls: string[] = [];
  page.on("request", request => { if (["fetch", "xhr", "document", "eventsource"].includes(request.resourceType())) urls.push(new URL(request.url()).pathname); });
  return urls;
}

test("Home stays quiet while idle, stops entirely in a hidden tab, and does not shift", async ({ page }) => {
  await openHome(page);
  expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls), "Home layout shift").toBeLessThan(0.1);

  const idle = countRequests(page);
  await page.clock.runFor(60_000);
  expect(idle.length, `requests in an idle minute: ${idle.join(", ")}`).toBeLessThanOrEqual(2);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hidden = countRequests(page);
  await page.clock.runFor(60_000);
  expect(hidden, "requests in a hidden tab").toEqual([]);
});
