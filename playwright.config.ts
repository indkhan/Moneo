import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { e2eStorageStatePath } from "./e2e/fixtures";

if (existsSync(".env.qa")) process.loadEnvFile(".env.qa");
const production = process.env.E2E_PRODUCTION_BUILD === "1";
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  testIgnore: process.env.E2E_REAL_AI === "1" ? [] : ["**/*.provider.spec.ts"],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: external ?? "http://localhost:3100",
    storageState: e2eStorageStatePath() ?? undefined,
    extraHTTPHeaders: { "x-moneo-test": "1" },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: external ? undefined : {
    command: production ? "node scripts/qa-server.mjs --production" : "node scripts/qa-server.mjs",
    port: 3100,
    reuseExistingServer: !production && !process.env.CI,
    timeout: 300_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
