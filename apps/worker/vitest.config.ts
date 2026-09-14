import { defineConfig } from "vitest/config";

// Every DB test builds a complete in-memory PostgreSQL migration chain.
// Serial files avoid concurrent WASM initialization starving hooks and hiding
// real failures behind arbitrary timeouts.
export default defineConfig({
  test: { fileParallelism: false, maxWorkers: 1, hookTimeout: 30_000, testTimeout: 30_000 },
});
