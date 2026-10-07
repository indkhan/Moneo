import {defineConfig} from "@playwright/test";
import {resolve} from "node:path";

export default defineConfig({
  testDir: ".", testMatch: "review-investigation.integration.ts", workers: 1, timeout: 120_000,
  outputDir: resolve(".qa/mne019-runtime/test-results"),
  use: {baseURL: "http://localhost:3040"},
  webServer: {command: "node scripts/review-runtime-server.mjs", env: {MNE019_RUNTIME: "1"}, cwd: process.cwd(), url: "http://localhost:3040", reuseExistingServer: false, timeout: 120_000},
});
