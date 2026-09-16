import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  build: {
    outDir: "../../proof-output/artifact-dist",
    emptyOutDir: true,
    assetsInlineLimit: 2_000_000,
    rollupOptions: { input: { host: resolve(root, "host.html"), renderer: resolve(root, "renderer.html") } },
  },
});
