import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
export default defineConfig({
  testDir: "./e2e", testMatch: "mne024.gated.spec.ts", workers: 1,
  expect: { timeout: 30_000 },
  use: { navigationTimeout: 30_000, actionTimeout: 30_000, baseURL: "http://localhost:3034", ...devices["Desktop Chrome"] },
  webServer: { command: "npm run start -- --port 3034", stdout: "pipe", port: 3034, reuseExistingServer: false, timeout: 120_000, env: { OPENROUTER_API_KEY: "" } },
});
