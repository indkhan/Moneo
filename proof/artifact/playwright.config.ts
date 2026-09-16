import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "artifact.spec.ts",
  timeout: 30_000,
  workers: 1,
  reporter: "line",
  use: { baseURL: "http://localhost:4173", trace: "retain-on-failure" },
  webServer: { command: "node server.mjs", url: "http://localhost:4173/host.html", reuseExistingServer: false },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
