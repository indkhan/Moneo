import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { e2eStorageStatePath } from "./e2e/fixtures";

// Specs run against the moneo-qa test backend (npm run setup -- --qa), never the owner's .env.
if (existsSync(".env.qa")) process.loadEnvFile(".env.qa");
const production = process.env.E2E_PRODUCTION_BUILD === "1";
// E2E_BASE_URL points the suite at an app that is already running (for example a production build on another port).
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  // e2e/*.test.ts are Vitest unit tests, not browser specs.
  testMatch: "**/*.spec.ts",
  // *.provider.spec.ts call the real AI model and cost money: they run only with E2E_REAL_AI=1.
  testIgnore: process.env.E2E_REAL_AI === "1" ? [] : ["**/*.provider.spec.ts"],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: external ?? "http://localhost:3100",
    // Every spec runs as the QA user. The header makes the app refuse, rather than sign in the
    // owner, when that session is missing or expired (proxy.ts).
    storageState: e2eStorageStatePath() ?? undefined,
    extraHTTPHeaders: { "x-moneo-test": "1" },
  },
  webServer: external ? undefined : {
    command: production ? "node scripts/qa-server.mjs --production" : "node scripts/qa-server.mjs",
    port: 3100,
    reuseExistingServer: !production && !process.env.CI,
    timeout: 300_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
