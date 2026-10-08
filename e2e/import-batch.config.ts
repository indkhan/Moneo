import { defineConfig, devices } from "@playwright/test";
process.loadEnvFile(".env");
// Start the candidate RPC proxy and the installed app on3052 independently.
export default defineConfig({ testDir: ".", testMatch: "import-control.gated.spec.ts", workers: 1,
  use: { baseURL: "http://localhost:3052", ...devices["Desktop Chrome"] },
  retries: 0,
});
