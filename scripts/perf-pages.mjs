// Page-load measurements against a running production build (`npm run build && npx next start -p 3101`).
// Per page and viewport it runs a few cold loads (fresh context, no HTTP cache) and reports the median TTFB, FCP, LCP,
// time until the page heading is visible, CLS, long tasks over 50 ms, transfer size and JS bytes.
//   node scripts/perf-pages.mjs <baseUrl> <label> [runs=3]      (needs e2e/.auth.json from scripts/e2e-auth.mjs)
// Writes .qa/perf-<label>.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, devices } from "@playwright/test";

const [base, label, runsArg] = process.argv.slice(2);
if (!base || !label) throw new Error("usage: node scripts/perf-pages.mjs <baseUrl> <label> [runs]");
const runs = Number(runsArg ?? 3);
const PAGES = ["/", "/ai", "/ai/artifacts", "/ai/activity", "/money/accounts", "/money/transactions", "/money/recurring", "/money/wealth", "/plan", "/plan/spending", "/settings"];
const VIEWPORTS = { desktop: { viewport: { width: 1440, height: 900 } }, mobile: { ...devices["Pixel 7"] } };

// Runs in the page before anything else: LCP, CLS, long tasks and when a heading first shows.
const probe = () => {
  const m = (window.__perf = { lcp: 0, cls: 0, longTasks: 0, longTaskMs: 0, heading: 0 });
  new PerformanceObserver(list => { for (const e of list.getEntries()) m.lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput) m.cls += e.value; }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver(list => { for (const e of list.getEntries()) { m.longTasks++; m.longTaskMs += e.duration; } }).observe({ type: "longtask", buffered: true });
  const tick = () => {
    const h = document.querySelector("main h1, h1");
    if (h && h.getBoundingClientRect().height > 0 && getComputedStyle(h).visibility !== "hidden") m.heading = performance.now(); else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const median = values => { const sorted = values.filter(v => v != null).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
const browser = await chromium.launch();
const result = {};
for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  for (const path of PAGES) {
    const samples = [];
    for (let run = -1; run < runs; run++) { // run -1 warms server caches and is not recorded
      const context = await browser.newContext({ ...vp, baseURL: base, storageState: "e2e/.auth.json" });
      await context.addInitScript(probe);
      const page = await context.newPage();
      let transfer = 0, js = 0, requests = 0;
      page.on("requestfinished", async request => {
        try {
          const sizes = await request.sizes(); const bytes = sizes.responseBodySize + sizes.responseHeadersSize;
          transfer += bytes; requests++;
          if (request.resourceType() === "script") js += sizes.responseBodySize;
        } catch { /* request gone with the context */ }
      });
      const response = await page.goto(path, { waitUntil: "load" }).catch(() => null);
      await page.waitForTimeout(3000);
      const m = await page.evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0];
        const fcp = performance.getEntriesByName("first-contentful-paint")[0];
        return { ...window.__perf, ttfb: nav.responseStart, fcp: fcp?.startTime ?? null, load: nav.loadEventEnd };
      });
      if (run >= 0) samples.push({ ...m, status: response?.status(), final: new URL(page.url()).pathname, transferKB: transfer / 1024, jsKB: js / 1024, requests });
      await context.close();
    }
    const pick = key => median(samples.map(s => s[key]));
    result[`${vpName} ${path}`] = { final: samples[0]?.final, status: samples[0]?.status, ttfb: pick("ttfb"), fcp: pick("fcp"), lcp: pick("lcp"), heading: pick("heading"), load: pick("load"),
      cls: pick("cls"), longTasks: pick("longTasks"), longTaskMs: pick("longTaskMs"), transferKB: pick("transferKB"), jsKB: pick("jsKB"), requests: pick("requests") };
    const r = result[`${vpName} ${path}`];
    console.log(`${vpName.padEnd(7)} ${path.padEnd(22)} ttfb ${r.ttfb?.toFixed(0)} fcp ${r.fcp?.toFixed(0)} lcp ${r.lcp?.toFixed(0)} heading ${r.heading?.toFixed(0)} cls ${r.cls?.toFixed(3)} lt ${r.longTasks}/${r.longTaskMs?.toFixed(0)}ms xfer ${r.transferKB?.toFixed(0)}KB js ${r.jsKB?.toFixed(0)}KB ${r.final !== path ? `-> ${r.final}` : ""}`);
  }
}
await browser.close();
mkdirSync(".qa", { recursive: true });
writeFileSync(`.qa/perf-${label}.json`, JSON.stringify(result, null, 2));
