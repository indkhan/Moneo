import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
export default defineConfig({ testDir: ".", testMatch: "investigation.gated.spec.ts", workers: 1,
  use: { baseURL: "http://localhost:3051", ...devices["Desktop Chrome"] },
  webServer: { command: "npm run start -- --port 3051", port: 3051, reuseExistingServer: false, timeout: 120_000, env: { OPENROUTER_API_KEY: "" } },
});
