// Loads desktop/src/backend under plain Node, bundled the way scripts/desktop/build.mjs bundles it
// for Electron (CommonJS, node22). Used by the backend-* scripts.
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

export const root = path.resolve(import.meta.dirname, "..", "..");
export const built = path.join(root, "desktop", ".build");

export async function loadBackend(outDir = mkdtempSync(path.join(os.tmpdir(), "moneo-desktop-backend-"))) {
  const outfile = path.join(outDir, "backend.cjs");
  await build({ entryPoints: [path.join(root, "desktop", "src", "backend", "index.ts")], bundle: true, platform: "node", format: "cjs",
    target: "node22", outfile, external: ["electron"], logLevel: "warning" });
  return createRequire(import.meta.url)(outfile);
}
