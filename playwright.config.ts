import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const production = process.env.E2E_PRODUCTION_BUILD === "1";
// E2E_BASE_URL points the suite at an app that is already running (for example a production build on another port).
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  // e2e/*.test.ts are Vitest unit tests, not browser specs.
  testMatch: "**/*.spec.ts",
  use: {
    baseURL: external ?? "http://localhost:3000",
  },
  webServer: external ? undefined : {
    command: production ? "npm start" : "npm run dev",
    port: 3000,
    reuseExistingServer: !production && !process.env.CI,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
