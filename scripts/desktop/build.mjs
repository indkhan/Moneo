// Builds the desktop app's pieces into desktop/.build (bundled resources) and desktop/dist (main process).
//   node scripts/desktop/build.mjs          Next.js standalone server + migrations + main process
//   node scripts/desktop/build.mjs --main   only the main process (npm run desktop:dev)
// The native backend (desktop/.build/backend, storage-api) comes from scripts/desktop/fetch-backend.mjs.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const desktop = path.join(root, "desktop");
const out = path.join(desktop, ".build");
const distDir = ".next-desktop";
const mainOnly = process.argv.includes("--main");

function fail(message) {
  console.error(`desktop build: ${message}`);
  process.exit(1);
}

function buildNext() {
  // NEXT_PUBLIC_* would be baked into the bundle; each desktop install has its own addresses and keys.
  const envFiles = [".env", ".env.local", ".env.production", ".env.production.local"].filter(name => existsSync(path.join(root, name)));
  const leaking = envFiles.filter(name => /^\s*NEXT_PUBLIC_/m.test(readFileSync(path.join(root, name), "utf8")));
  if (leaking.length) fail(`${leaking.join(", ")} set NEXT_PUBLIC_* variables, which Next.js would build into the app. Build the desktop app from a checkout without them (CI, or a fresh worktree).`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("NEXT_PUBLIC_")));
  Object.assign(env, { MONEO_DESKTOP_BUILD: "1", NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: "1" });
  const result = spawnSync(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "build"], { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) fail("next build failed");
}

// Fails when a local Supabase address was inlined anyway.
// A whole string literal holding the address is a baked-in value; an example inside a message is fine.
// Returns how many files still read the Supabase URL at runtime.
function checkNoInlinedAddresses(dir) {
  const hits = [];
  let runtimeReads = 0;
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs|cjs|json|html|rsc|txt|body|meta)$/.test(entry.name) && statSync(full).size < 20_000_000) {
        const text = readFileSync(full, "utf8");
        if (/(["'`])https?:\/\/(127\.0\.0\.1|localhost):543\d\d\/?\1/.test(text)) hits.push(path.relative(root, full));
        if (text.includes("process.env.NEXT_PUBLIC_SUPABASE_URL")) runtimeReads++;
      }
    }
  };
  walk(dir);
  if (hits.length) fail(`local Supabase addresses were built into:\n  ${hits.slice(0, 20).join("\n  ")}`);
  return runtimeReads;
}

function assemble() {
  const built = path.join(root, distDir);
  const standalone = path.join(built, "standalone");
  if (!existsSync(path.join(standalone, "server.js"))) fail(`${distDir}/standalone/server.js is missing; is output: "standalone" on?`);
  if (!checkNoInlinedAddresses(standalone)) fail("no server file reads NEXT_PUBLIC_SUPABASE_URL at runtime; was it inlined?");
  checkNoInlinedAddresses(path.join(built, "static"));
  const app = path.join(out, "app");
  rmSync(app, { recursive: true, force: true });
  cpSync(standalone, app, { recursive: true, dereference: true });
  // Some dynamic paths (lib/phone-access.ts) make tracing copy the whole checkout; the server runs
  // without any of the source, so keep only what it needs.
  const keep = new Set([distDir, "node_modules", "server.js", "package.json"]);
  for (const entry of readdirSync(app)) if (!keep.has(entry)) rmSync(path.join(app, entry), { recursive: true, force: true });
  cpSync(path.join(built, "static"), path.join(app, distDir, "static"), { recursive: true });
  cpSync(path.join(root, "public"), path.join(app, "public"), { recursive: true });
  // Read from disk at runtime (outputFileTracingIncludes in next.config.ts); fail early if tracing missed them.
  for (const file of ["node_modules/echarts/dist/echarts.min.js", "node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm", "node_modules/@workflow/world-local/package.json"]) {
    if (!existsSync(path.join(app, file))) fail(`${file} is missing from the standalone server`);
  }
  const migrations = path.join(out, "migrations");
  rmSync(migrations, { recursive: true, force: true });
  cpSync(path.join(root, "supabase", "migrations"), migrations, { recursive: true });
  const bootstrap = path.join(desktop, "bootstrap");
  if (existsSync(bootstrap)) {
    rmSync(path.join(out, "bootstrap"), { recursive: true, force: true });
    cpSync(bootstrap, path.join(out, "bootstrap"), { recursive: true });
  }
}

async function buildMain() {
  const common = { bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], sourcemap: "linked", logLevel: "warning", absWorkingDir: desktop };
  await build({ ...common, entryPoints: { main: "src/main.ts" }, outdir: "dist" });
  await build({ ...common, entryPoints: { preload: "src/preload.ts" }, outdir: "dist" });
  console.log("desktop build: main process bundled into desktop/dist");
}

if (!mainOnly) {
  buildNext();
  assemble();
}
rmSync(path.join(desktop, "dist"), { recursive: true, force: true });
await buildMain();
for (const part of ["backend", "storage-api"]) {
  if (!existsSync(path.join(out, part))) console.warn(`desktop build: desktop/.build/${part} is missing; run scripts/desktop/fetch-backend.mjs before packaging.`);
}
