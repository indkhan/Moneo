import { expect, test } from "@playwright/test";
import { e2eStorageStatePath } from "./fixtures";

const signedIn = e2eStorageStatePath();
if (signedIn) test.use({ storageState: signedIn });
test.skip(!signedIn, "Needs the QA session (scripts/e2e-auth.mjs)");

const pem = "-----BEGIN PRIVATE KEY-----\nMIIsynthetic\n-----END PRIVATE KEY-----\n";

test("a new owner connects a first and a second bank from Accounts without visiting Settings", async ({ page }) => {
  let configured = false;
  const saved: unknown[] = [];
  const connections: unknown[] = [];
  const bank = (id: string, name: string) => ({ id, aspsp_name: name, aspsp_country: "DE", status: "active", valid_until: "2027-05-01T00:00:00Z", last_synced_at: null,
    sync_started_at: null, last_error: null, problem: null, next_sync_at: null, accounts: [{ provider_account_uid: `${id}-1`, account_name: `${name} Girokonto`, currency_code: "EUR", last_booked_on: null }],
    sync: { running: false, imports: [] } });
  await page.route("**/api/bank/connections", route => route.fulfill({ json: {
    configured, credentials: configured ? { source: "app", hint: "f00d" } : { source: null, hint: null },
    redirectUrl: "https://localhost:3443/api/bank/callback", connections } }));
  await page.route("**/api/scalable/connections", route => route.fulfill({ json: { configured: true, connection: null } }));
  await page.route("**/api/bank/credentials", async route => {
    saved.push(route.request().postDataJSON());
    configured = true;
    await route.fulfill({ json: { saved: true } });
  });
  await page.route("**/api/bank/aspsps?country=*", route => route.fulfill({ json: { banks: [{ name: "Testbank", country: "DE" }, { name: "Other Bank", country: "DE" }] } }));
  const opened: string[] = [];
  await page.route("**/api/bank/connect", async route => {
    const { aspspName } = route.request().postDataJSON();
    opened.push(aspspName);
    connections.unshift(bank(`b${connections.length + 1}`, aspspName));
    await route.fulfill({ json: { url: "/money/accounts?bank=connected#connected" } });
  });

  await page.goto("/money/accounts?connect=bank#connected");
  const flow = page.getByRole("group", { name: "Connect a bank" });
  await expect(flow.getByText("https://localhost:3443/api/bank/callback")).toBeVisible();
  await flow.getByLabel("App ID").fill("app-synthetic");
  await flow.getByLabel("Or upload the .pem file").setInputFiles({ name: "app-synthetic.pem", mimeType: "application/x-pem-file", buffer: Buffer.from(pem) });
  await expect(flow.getByLabel("Private key")).toHaveValue(pem);
  await flow.getByRole("button", { name: "Save and check" }).click();
  await expect(flow.getByText("Enable Banking is set up. Choose your bank to connect it.")).toBeVisible();
  expect(saved).toEqual([{ appId: "app-synthetic", privateKey: pem }]);
  await flow.getByLabel("Search", { exact: true }).fill("test");
  await expect(flow.getByRole("button", { name: /Other Bank/ })).toHaveCount(0);
  await flow.getByRole("button", { name: /Testbank/ }).click();

  await expect(page).toHaveURL(/\/money\/accounts\?bank=connected#connected$/);
  const first = page.getByRole("article", { name: "Testbank" });
  await expect(first).toContainText("Testbank Girokonto");
  await expect(page.getByText("Enable Banking app ending in f00d")).toBeVisible();

  await page.getByRole("button", { name: "Connect another bank" }).click();
  const again = page.getByRole("group", { name: "Connect a bank" });
  await expect(again.getByLabel("App ID")).toHaveCount(0);
  await again.getByRole("button", { name: /Other Bank/ }).click();
  await expect(page.getByRole("article", { name: "Other Bank" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Testbank" })).toBeVisible();
  expect(opened).toEqual(["Testbank", "Other Bank"]);
});

test("Ask explains missing AI and voice access instead of failing", async ({ page }) => {
  await page.route("**/api/ai/status", route => route.fulfill({ json: { ai: false, voice: false } }));
  await page.goto("/ai?conversation=new");
  await expect(page.getByText("No AI is set up yet.")).toBeVisible();
  const settings = page.getByRole("link", { name: "Settings → AI access" }).first();
  await page.getByRole("button", { name: "Call", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Voice calls and dictation need an OpenAI API key." })).toBeVisible();
  await page.getByRole("button", { name: "Talk: record a voice message" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Add one in Settings" }).last()).toBeVisible();
  await settings.click();
  await expect(page).toHaveURL(/\/settings#ai-access$/);
  const access = page.locator("#ai-access");
  await expect(access).toBeVisible();
  await expect.poll(() => access.evaluate(section => Math.abs(section.getBoundingClientRect().top - parseFloat(getComputedStyle(section).scrollMarginTop)))).toBeLessThan(2);
});

test("Settings jumps to AI access and shows no setup warning when setup is complete", async ({ page }) => {
  await page.route("**/api/bank/connections", route => route.fulfill({ json: {
    configured: false, credentials: { source: null, hint: null }, redirectUrl: "https://localhost:3443/api/bank/callback", connections: [] } }));
  await page.goto("/settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "AI access" }).click();
  await expect(page).toHaveURL(/#ai-access$/);
  await expect(page.getByRole("heading", { name: "AI access", exact: true }).first()).toBeInViewport();
  await expect(page.getByText("Setup is incomplete")).toHaveCount(0);
});

test("ChatGPT or OpenRouter chat stays available while voice shows a missing-key toast", async ({ page }) => {
  await page.route("**/api/ai/status", route => route.fulfill({ json: { ai: true, voice: false } }));
  let voiceRequests = 0;
  await page.route("**/api/voice/**", route => { voiceRequests++; return route.abort(); });
  await page.goto("/ai?conversation=new");
  await expect(page.getByText("No AI is set up yet.")).toHaveCount(0);
  await page.getByRole("button", { name: "Call", exact: true }).click();
  const toast = page.getByRole("alert").filter({ hasText: "Normal chat and other AI features still work" });
  await expect(toast).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Voice call with Moneo" })).toHaveCount(0);
  await page.getByRole("button", { name: "Dismiss voice notice" }).click();
  await expect(toast).toHaveCount(0);
  await page.getByRole("button", { name: "Talk: record a voice message" }).click();
  await expect(toast).toBeVisible();
  const status = page.waitForResponse("**/api/ai/status");
  await page.goto("/settings");
  await status;
  await page.clock.install();
  await page.getByRole("button", { name: "Play sample" }).click();
  await expect(toast).toBeVisible();
  await page.clock.fastForward(8000);
  await expect(toast).toHaveCount(0);
  expect(voiceRequests).toBe(0);
});
