import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Playwright specs live under e2e/ and run via `pnpm test:e2e`, not vitest.
    exclude: ["e2e/**", "node_modules/**", "dist/**", ".next/**"],
    passWithNoTests: true,
  },
});
