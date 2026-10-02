import { test, expect } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());

test("real QuickJS worker denies host capabilities, enforces limits and recovers", async ({ page }) => {
  test.setTimeout(90_000);
  // Substitute source only at the host boundary; retain the real compiled Worker,
  // QuickJS WASM, message handlers, memory/stack/interrupt limits and termination.
  await page.addInitScript(() => {
    const nativePost = Worker.prototype.postMessage;
    (window as unknown as { qaSource: string }).qaSource = "()=>({summary:'Worker recovered'})";
    Worker.prototype.postMessage = function (message, ...rest: unknown[]) {
      const payload = message && typeof message === "object" && "source" in message
        ? { ...message, source: (window as unknown as { qaSource: string }).qaSource } : message;
      return Reflect.apply(nativePost, this, [payload, ...rest]);
    };
    localStorage.setItem("qa-host-secret", "synthetic-secret-outside-sandbox");
  });
  const external: string[] = [];
  page.on("request", request => { if (request.url().includes("sandbox-escape.invalid")) external.push(request.url()); });
  await page.goto("/ai/library");
  const create = page.locator("form").filter({ has: page.getByLabel("Custom Comparison", { exact: true }) });
  await create.getByLabel("Custom Comparison", { exact: true }).fill(`Isolation QA ${crypto.randomUUID().slice(0, 8)}`);
  await create.getByRole("button", { name: "Create", exact: true }).click();
  const editor = page.getByRole("region", { name: "Edit calculator version" });
  await editor.locator(".cm-content").fill(`()=>({summary:"Worker recovered"})`);
  await editor.getByLabel("Manifest (JSON)").fill(JSON.stringify({ kind: "custom_comparison", runtime: "quickjs-calculator-v1", sdk: [], params: {}, renderer: "trusted" }));
  await editor.getByRole("button", { name: "Save new version", exact: true }).click();
  const check = page.getByRole("region", { name: "Generated calculator output" });
  await expect(check).toContainText("Worker recovered", { timeout: 20_000 });
  const run = async (source: string) => {
    await page.evaluate(value => { (window as unknown as { qaSource: string }).qaSource = value; }, source);
    await check.getByRole("button", { name: "Re-run", exact: true }).click();
  };
  await run(`()=>({summary:[typeof window,typeof document,typeof fetch,typeof localStorage,typeof indexedDB,typeof navigator,typeof process,typeof require,typeof self,typeof Worker,typeof XMLHttpRequest,typeof WebSocket].join(",")})`);
  await expect(check).toContainText(Array(12).fill("undefined").join(","));
  await run(`()=>fetch("https://sandbox-escape.invalid/private")`);
  await expect(check.getByRole("status")).toContainText("not defined");
  expect(external).toEqual([]);
  await run(`()=>{while(true){} }`);
  await expect(check.getByRole("status")).toContainText(/interrupted|timed out/i, { timeout: 10_000 });
  await run(`()=>{const a=[];for(let i=0;i<1000000;i++)a.push({i,value:"retained"+i});return a.length}`);
  await expect(check.getByRole("status")).toContainText(/memory|allocation|out of|failed/i, { timeout: 10_000 });
  await run(`function recur(){return recur()}`);
  // QuickJS may abort during cleanup after its stack guard; the host must remain
  // responsive and the next isolated worker must still run successfully.
  await expect(check.getByRole("status")).toContainText(/stack|overflow|Aborted\(Assertion failed/i, { timeout: 10_000 });
  await run("()=>({");
  await expect(check.getByRole("status")).toContainText("invalid property name");
  await run(" ".repeat(20_001));
  await expect(check.getByRole("status")).toContainText("Artifact source is too large");
  await run("()=>({summary:'Worker recovered'})");
  await expect(check.getByText("Worker recovered", { exact: true })).toBeVisible();
});

test("revoked host SDK scope yields unavailable evidence without financial rows", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/ai/library");
  const create = page.locator("form").filter({ has: page.getByLabel("Custom Comparison", { exact: true }) });
  await create.getByLabel("Custom Comparison", { exact: true }).fill(`Scope QA ${crypto.randomUUID().slice(0, 8)}`);
  await create.getByRole("button", { name: "Create", exact: true }).click();
  const editor = page.getByRole("region", { name: "Edit calculator version" });
  await expect(editor).toBeVisible();
  const artifactUrl = page.url();
  await editor.locator(".cm-content").fill(`input=>input.snapshot.unavailable?{unavailable:input.snapshot.unavailable,numbers:{financialRowsSupplied:String(Boolean(input.snapshot.spending))}}:{summary:"Evidence available",numbers:{financialRowsSupplied:String(Boolean(input.snapshot.spending))}}`);
  await editor.getByLabel("Manifest (JSON)").fill(JSON.stringify({ kind: "custom_comparison", runtime: "quickjs-calculator-v1", sdk: ["spending"], params: {}, renderer: "trusted" }));
  await editor.getByRole("button", { name: "Save new version", exact: true }).click();
  const output = page.getByRole("region", { name: "Generated calculator output" });
  await expect(output.getByText("financialRowsSupplied", { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.goto("/settings");
  const transactions = page.locator('input[name="ai_data_scopes"][value="transactions"]');
  const initiallyEnabled = await transactions.isChecked();
  try {
    await transactions.uncheck();
    await page.getByRole("button", { name: "Save preferences", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Preferences saved" })).toBeVisible();
    await page.goto(artifactUrl);
    await expect(output).toContainText("AI access to transactions is disabled in Settings", { timeout: 20_000 });
    await expect(output.locator("dd")).toHaveText("false");
    await expect(output).not.toContainText("Evidence available");
  } finally {
    await page.goto("/settings");
    await transactions.setChecked(initiallyEnabled);
    await page.getByRole("button", { name: "Save preferences", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Preferences saved" })).toBeVisible();
  }
});

test("Stop terminates the actual calculator worker and later runs recover", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const originalPost = Worker.prototype.postMessage, originalTerminate = Worker.prototype.terminate;
    const host = window as unknown as { qaHold: boolean; qaStarts: number; qaTerminations: number };
    host.qaHold = false; host.qaStarts = 0; host.qaTerminations = 0;
    Worker.prototype.postMessage = function (message, ...rest: unknown[]) {
      if (message && typeof message === "object" && "source" in message) {
        host.qaStarts++;
        if (host.qaHold) message = { ...message, source: "()=>{while(true){} }" };
      }
      return Reflect.apply(originalPost, this, [message, ...rest]);
    };
    Worker.prototype.terminate = function () { host.qaTerminations++; return originalTerminate.call(this); };
  });
  await page.goto("/ai/library");
  const create = page.locator("form").filter({ has: page.getByLabel("Custom Comparison", { exact: true }) });
  await create.getByLabel("Custom Comparison", { exact: true }).fill(`Stop QA ${crypto.randomUUID().slice(0, 8)}`);
  await create.getByRole("button", { name: "Create", exact: true }).click();
  const editor = page.getByRole("region", { name: "Edit calculator version" });
  await editor.locator(".cm-content").fill(`()=>({summary:"Worker recovered"})`);
  await editor.getByLabel("Manifest (JSON)").fill(JSON.stringify({ kind: "custom_comparison", runtime: "quickjs-calculator-v1", sdk: [], params: {}, renderer: "trusted" }));
  await editor.getByRole("button", { name: "Save new version", exact: true }).click();
  const output = page.getByRole("region", { name: "Generated calculator output" });
  await expect(output).toContainText("Worker recovered", { timeout: 20_000 });
  const before = await page.evaluate(() => {
    const host = window as unknown as { qaHold: boolean; qaStarts: number; qaTerminations: number }; host.qaHold = true;
    return { starts: host.qaStarts, terminations: host.qaTerminations };
  });
  await output.getByRole("button", { name: "Re-run", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { qaStarts: number }).qaStarts)).toBeGreaterThan(before.starts);
  await expect(output.getByRole("status")).toContainText("Running in QuickJS/Web Worker");
  expect(await page.evaluate(() => (window as unknown as { qaTerminations: number }).qaTerminations)).toBe(before.terminations);
  await output.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(output).toContainText("Stopped. Re-run to execute again.");
  await expect.poll(() => page.evaluate(() => (window as unknown as { qaTerminations: number }).qaTerminations)).toBe(before.terminations + 1);
  await page.waitForTimeout(1200);
  await expect(output).toContainText("Stopped. Re-run to execute again.");
  await expect(output).not.toContainText("Calculator failed");
  await page.evaluate(() => { (window as unknown as { qaHold: boolean }).qaHold = false; });
  await output.getByRole("button", { name: "Re-run", exact: true }).click();
  await expect(output).toContainText("Worker recovered");
});
