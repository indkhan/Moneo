import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: {
    "@": fileURLToPath(new URL(".", import.meta.url)),
    "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
  } },
  test: {
    environment: "node",
    isolate: false,
    sequence: { shuffle: true },
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: [...configDefaults.exclude, ".qa/**", ".claude/**", ".next-desktop/**", "desktop/.build/**", "desktop/.cache/**", "desktop/release/**", "desktop/release-preview/**"],
  },
});
