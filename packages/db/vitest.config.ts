import { defineConfig } from "vitest/config";

// Each file starts a PGlite instance and applies the full migration chain.
// Running those migrations in parallel exhausts the WASM worker pool and
// produces hook timeouts; serial execution preserves real failure signals.
export default defineConfig({
  test: { fileParallelism: false, maxWorkers: 1, hookTimeout: 30_000, testTimeout: 30_000 },
});
