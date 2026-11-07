import { expect, test } from "@playwright/test";
import { e2eStorageStatePath } from "./fixtures";

// Pages need a session; the key APIs are stubbed, so nothing reaches the install-wide key table.
const signedIn = e2eStorageStatePath();
if (signedIn) test.use({ storageState: signedIn });
test.skip(!signedIn, "Needs the QA session (scripts/e2e-auth.mjs)");

const pem = "-----BEGIN PRIVATE KEY-----\nMIIsynthetic\n-----END PRIVATE KEY-----\n";

test("Connected banks asks for the Enable Banking App ID and key when none is set up", async ({ page }) => {
  let configured = false;
  const saved: unknown[] = [];
  await page.route("**/api/bank/connections", route => route.fulfill({ json: {
    configured, credentials: configured ? { source: "app", hint: "f00d" } : { source: null, hint: null },
    redirectUrl: "https://localhost:3443/api/bank/callback", connections: [] } }));
  await page.route("**/api/bank/credentials", async route => {
    saved.push(route.request().postDataJSON());
    configured = true;
    await route.fulfill({ json: { saved: true } });
  });
  await page.goto("/import#connected-banks");
  const banks = page.getByRole("region", { name: "Connected banks" });
  await expect(banks.getByText("https://localhost:3443/api/bank/callback")).toBeVisible();
  await expect(banks.getByText("https://indkhan.github.io/Moneo/privacy.html")).toBeVisible();
  await banks.getByLabel("App ID").fill("app-synthetic");
  await banks.getByLabel("Or upload the .pem file").setInputFiles({ name: "app-synthetic.pem", mimeType: "application/x-pem-file", buffer: Buffer.from(pem) });
  await expect(banks.getByLabel("Private key")).toHaveValue(pem);
  await banks.getByRole("button", { name: "Save and check" }).click();
  await expect(banks.getByText("Enable Banking is set up. Choose your bank to connect it.")).toBeVisible();
  await expect(banks.getByRole("button", { name: "Choose a bank" })).toBeVisible();
  await expect(banks.getByText("Enable Banking app ending in f00d")).toBeVisible();
  expect(saved).toEqual([{ appId: "app-synthetic", privateKey: pem }]);
});

test("Ask explains missing AI and voice access instead of failing", async ({ page }) => {
  await page.route("**/api/ai/status", route => route.fulfill({ json: { ai: false, voice: false } }));
  await page.goto("/ai?conversation=new");
  await expect(page.getByText("No AI is set up yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings → AI access" }).first()).toHaveAttribute("href", "/settings#ai-access");
  await page.getByRole("button", { name: "Call", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Voice calls and dictation need an OpenAI API key." })).toBeVisible();
  await page.getByRole("button", { name: "Talk: record a voice message" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Add one in Settings" }).last()).toBeVisible();
});

test("Settings keeps every key and connection in one section", async ({ page }) => {
  await page.route("**/api/bank/connections", route => route.fulfill({ json: {
    configured: false, credentials: { source: null, hint: null }, redirectUrl: "https://localhost:3443/api/bank/callback", connections: [] } }));
  await page.goto("/settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Keys and connections" }).click();
  await expect(page).toHaveURL(/#connections$/);
  const section = page.getByRole("region", { name: "Keys and connections" });
  for (const name of ["AI access", "Connected banks", "Scalable Capital", "Set up automatically"])
    await expect(section.getByRole("heading", { name, exact: true }).first()).toBeVisible();
  await expect(section.getByText("Encryption for saved keys and bank sessions")).toBeVisible();
  await expect(section.getByText("Missing: run npm run setup")).toHaveCount(0);
});
