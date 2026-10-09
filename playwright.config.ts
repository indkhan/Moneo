import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const production = process.env.E2E_PRODUCTION_BUILD === "1";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://localhost:3000",
  },
  webServer: {
    command: production ? "npm start" : "npm run dev",
    port: 3000,
    reuseExistingServer: !production && !process.env.CI,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
