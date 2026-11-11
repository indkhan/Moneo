import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["**/*.test.{ts,tsx}"],
    // Desktop build output and downloads hold copies of the source.
    exclude: [...configDefaults.exclude, ".qa/**", ".claude/**", ".next-desktop/**", "desktop/.build/**", "desktop/.cache/**", "desktop/release/**", "desktop/release-preview/**"],
  },
});
