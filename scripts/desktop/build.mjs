import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function withTraceProbe(run) {
  const dataFolder = path.join(root, ".data");
  const probe = path.join(dataFolder, "trace-probe");
  const hadFolder = existsSync(dataFolder);
  if (!hadFolder) mkdirSync(dataFolder);
  const addedProbe = !existsSync(probe);
  if (addedProbe) writeFileSync(probe, "");
  try {
    return run();
  } finally {
    if (addedProbe) rmSync(probe, { force: true });
    if (!hadFolder) rmSync(dataFolder, { recursive: true, force: true });
  }
}

function buildNext() {
  const envFiles = [".env", ".env.local", ".env.production", ".env.production.local"].filter(name => existsSync(path.join(root, name)));
  const leaking = envFiles.filter(name => /^\s*NEXT_PUBLIC_/m.test(readFileSync(path.join(root, name), "utf8")));
  if (leaking.length) fail(`${leaking.join(", ")} set NEXT_PUBLIC_* variables, which Next.js would build into the app. Build the desktop app from a checkout without them (CI, or a fresh worktree).`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("NEXT_PUBLIC_")));
  Object.assign(env, { MONEO_DESKTOP_BUILD: "1", NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: "1" });
  const result = withTraceProbe(() => spawnSync(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "build"], { cwd: root, env, stdio: "inherit" }));
  if (result.status !== 0) fail("next build failed");
}

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
  const extra = readdirSync(app).filter(entry => ![distDir, "node_modules", "server.js", "package.json"].includes(entry));
  if (extra.length) fail(`the standalone server traced source files (${extra.join(", ")}); add /*turbopackIgnore: true*/ to the dynamic path Next.js warned about`);
  cpSync(path.join(built, "static"), path.join(app, distDir, "static"), { recursive: true });
  cpSync(path.join(root, "public"), path.join(app, "public"), { recursive: true });
  for (const file of ["node_modules/echarts/dist/echarts.min.js", "node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm", "node_modules/@workflow/world-local/package.json",
    `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${process.platform === "win32" ? ".exe" : ""}`]) {
    if (!existsSync(path.join(app, file))) fail(`${file} is missing from the standalone server`);
  }
  const speechRuntime = `node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`;
  if (existsSync(path.join(root, speechRuntime)) && !existsSync(path.join(app, speechRuntime))) fail(`${speechRuntime} is missing from the standalone server; local speech to text needs it`);
  const migrations = path.join(out, "migrations");
  rmSync(migrations, { recursive: true, force: true });
  cpSync(path.join(root, "supabase", "migrations"), migrations, { recursive: true });
  const bootstrap = path.join(desktop, "bootstrap");
  if (existsSync(bootstrap)) {
    rmSync(path.join(out, "bootstrap"), { recursive: true, force: true });
    cpSync(bootstrap, path.join(out, "bootstrap"), { recursive: true });
  }
}

function replaceSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { replaceSymlinks(full); continue; }
    if (!entry.isSymbolicLink()) continue;
    const link = readlinkSync(full);
    let target = null;
    try { target = realpathSync(full); } catch {}
    rmSync(full, { force: true });
    if (target) cpSync(target, full, { recursive: true, dereference: true });
    console.log(`desktop build: ${target ? "copied" : "removed broken link"} ${path.relative(out, full)} -> ${link}`);
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
if (!mainOnly && existsSync(out)) replaceSymlinks(out);
for (const part of ["backend", "storage-api"]) {
  if (!existsSync(path.join(out, part))) console.warn(`desktop build: desktop/.build/${part} is missing; run scripts/desktop/fetch-backend.mjs before packaging.`);
}
