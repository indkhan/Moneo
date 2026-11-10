// Downloads, verifies and builds the native backend that Moneo Desktop bundles instead of Docker:
// PostgreSQL 17 with contrib, PostgREST, GoTrue (supabase/auth, cross-compiled with CGO off),
// mkcert and the Storage API (supabase/storage, a Node app). Every download is pinned by
// SHA-256 below; downloads are cached in desktop/.cache, results land in desktop/.build:
//   desktop/.build/backend/<platform>/{postgres/,postgrest/,gotrue/,mkcert[.exe],fs-xattr/,manifest.json}
//   desktop/.build/storage-api/            (platform-independent; see fs-xattr below)
//   desktop/.build/migrations/, desktop/.build/bootstrap/   (copies of supabase/migrations, desktop/bootstrap)
//
//   node scripts/desktop/fetch-backend.mjs --platform win-x64 [--platform mac-arm64 ...] [--skip storage,gotrue]
//
// Platforms: win-x64, mac-arm64, mac-x64, linux-x64. Everything cross-builds from any host except
// the fs-xattr addon for macOS/Linux, which compiles only on a host of that platform (CI does that).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = resolve(import.meta.dirname, "..", "..");
const cache = join(root, "desktop", ".cache");
const out = join(root, "desktop", ".build");

const PLATFORMS = {
  "win-x64": { os: "win32", arch: "x64", goos: "windows", goarch: "amd64", exe: ".exe", postgres: "x86_64-pc-windows-msvc", postgrest: "windows-x86-64.zip", mkcert: "windows-amd64.exe" },
  "mac-arm64": { os: "darwin", arch: "arm64", goos: "darwin", goarch: "arm64", exe: "", postgres: "aarch64-apple-darwin", postgrest: "macos-aarch64.tar.xz", mkcert: "darwin-arm64" },
  "mac-x64": { os: "darwin", arch: "x64", goos: "darwin", goarch: "amd64", exe: "", postgres: "x86_64-apple-darwin", postgrest: "macos-x86-64.tar.xz", mkcert: "darwin-amd64" },
  "linux-x64": { os: "linux", arch: "x64", goos: "linux", goarch: "amd64", exe: "", postgres: "x86_64-unknown-linux-gnu", postgrest: "linux-static-x86-64.tar.xz", mkcert: "linux-amd64" },
};

// Pinned inputs. To upgrade one, change its version and every sha256 next to it.
export const PINS = {
  // Relocatable builds from PostgreSQL source with all client tools and contrib (pgcrypto, pg_trgm),
  // PostgreSQL License, with bundled dependency notices. zonky's embedded binaries lack pg_dump/pg_restore.
  postgres: {
    version: "17.11", release: "17.11.1", license: "PostgreSQL",
    url: target => `https://github.com/theseus-rs/postgresql-binaries/releases/download/17.11.1/postgresql-17.11.1-${target}.tar.gz`,
    sha256: {
      "win-x64": "9855f1b2a9acf127e148fbdd929ef118bfe2fc095c9358a7da74bdc02cedfc27",
      "mac-arm64": "f4b2ff0587d80b6f22bf09ec2d133a3c2949b6423318d3fed0f4ddddddf2f004",
      "mac-x64": "edb44b25cf8bffec60fa300fbe100fa4238bf2cab4f4bd98d4b7255c61780df3",
      "linux-x64": "aa8e2e97574bd789119ac01f1dddcd7a038c84e5c308d7b753018618258f0fbd",
    },
  },
  postgrest: {
    version: "v16.5", license: "MIT",
    url: asset => `https://github.com/PostgREST/postgrest/releases/download/v16.5/postgrest-v16.5-${asset}`,
    sha256: {
      "win-x64": "17f595b0d8dd37473d0231417dea07c5ac9f791282ff5b017fae51ff29e5de2f",
      "mac-arm64": "d8095cb439de0a3151036df542139e7afca5cebb109ce7f1bae52b3a97e9846a",
      "mac-x64": "dd4d346cd65dba4863ae02686fd09d2e34bbb6889e05d8ff7f1ac42ba0939515",
      "linux-x64": "5099e7ada38f9f6846cd87c14c5f158b7c165f1e9959665ad412e61f4dceba95",
    },
  },
  mkcert: {
    version: "v1.4.4", license: "BSD-3-Clause",
    url: asset => `https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-${asset}`,
    sha256: {
      "win-x64": "d2660b50a9ed59eada480750561c96abc2ed4c9a38c6a24d93e30e0977631398",
      "mac-arm64": "c8af0df44bce04359794dad8ea28d750437411d632748049d08644ffb66a60c6",
      "mac-x64": "a32dfab51f1845d51e810db8e47dcf0e6b51ae3422426514bf5a2b8302e97d4e",
      "linux-x64": "6d31c65b03972c6dc4a14ab429f2928300518b26503f58723e532d1b0a3bbb52",
    },
  },
  // Build-only toolchain for GoTrue, matching supabase/auth's go.mod and Dockerfile.
  go: {
    version: "go1.27.0",
    sha256: {
      "windows-amd64.zip": "f0c0a0d33ba94f4d2c5dbc887334ce678b21813504ddb3aafcb06e60a5a667c4",
      "darwin-arm64.tar.gz": "90493b3bbd5e10f91d12153198bf1994fd756399b4fec93b49b0c6e2acdeeb3e",
      "darwin-amd64.tar.gz": "d3314e25496e4381d71a5c51d2907e7af655d199f6780b549f015bd85fef4986",
      "linux-amd64.tar.gz": "675c26c449cbb18fc24b74650de1eabbae6e16f64326fd85a283fb3b58280685",
      "linux-arm64.tar.gz": "51798d2c42d0e1c6ed7fd9f48728b4193abac9e8aad6dbac2fe96a81f5909bda",
    },
  },
  gotrue: {
    version: "v2.197.0", commit: "4eee58f296d9698a1c2c0ae14d7a0b379c7622d3", license: "MIT",
    url: "https://github.com/supabase/auth/archive/refs/tags/v2.197.0.tar.gz", folder: "auth-2.197.0",
    sha256: "d21291c281604ccc6272c81c6506c8d521bc38d3141b0d339cb1a5988b1d461d",
  },
  storage: {
    version: "v1.88.0", commit: "327681449182ade2f9173c968dd8e8ee3c9888fd", license: "Apache-2.0",
    url: "https://github.com/supabase/storage/archive/refs/tags/v1.88.0.tar.gz", folder: "storage-1.88.0",
    sha256: "09ed5ddb38f44e2bf917b5e5f2a15b243134fa3f5542e9090d2a5ba2c9416731",
  },
};

// PostgreSQL programs the backend uses: server, cluster setup, backups and a shell for support.
const POSTGRES_PROGRAMS = new Set(["postgres", "initdb", "pg_ctl", "pg_dump", "pg_dumpall", "pg_restore", "psql",
  "pg_isready", "pg_controldata", "pg_resetwal", "pg_upgrade", "pg_checksums"]);

function args() {
  const platforms = [], skip = new Set();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--platform") platforms.push(...argv[++i].split(","));
    else if (argv[i] === "--skip") argv[++i].split(",").forEach(part => skip.add(part));
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  if (!platforms.length) platforms.push(hostPlatform());
  for (const platform of platforms) if (!PLATFORMS[platform]) throw new Error(`Unknown platform ${platform}; use ${Object.keys(PLATFORMS).join(", ")}`);
  return { platforms, skip };
}

function hostPlatform() {
  const name = Object.entries(PLATFORMS).find(([, p]) => p.os === process.platform && p.arch === process.arch)?.[0];
  if (!name) throw new Error(`No Moneo Desktop backend for ${process.platform}-${process.arch}`);
  return name;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} exited with ${result.status}`);
}

async function sha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function download(url, expected, name) {
  const file = join(cache, "downloads", name);
  if (existsSync(file) && await sha256(file) === expected) return file;
  await fs.mkdir(dirname(file), { recursive: true });
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const partial = `${file}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const actual = await sha256(partial);
  if (actual !== expected) { await fs.rm(partial, { force: true }); throw new Error(`${name}: sha256 ${actual}, expected ${expected}`); }
  await fs.rename(partial, file);
  return file;
}

// bsdtar (Windows 10+, macOS) reads zip, gzip and xz; GNU tar on Linux needs unzip for zips.
// On Windows always the system bsdtar, never Git's GNU tar, which reads "C:" as a remote host.
async function extract(archive, dest) {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  if (process.platform === "win32") run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", archive, "-C", dest]);
  else if (archive.endsWith(".zip") && process.platform === "linux") run("unzip", ["-q", archive, "-d", dest]);
  else run("tar", ["-xf", archive, "-C", dest]);
}

async function single(dir) {
  const entries = await fs.readdir(dir);
  return entries.length === 1 ? join(dir, entries[0]) : dir;
}

async function remove(path) { await fs.rm(path, { recursive: true, force: true }); }

async function size(path) {
  const stat = await fs.lstat(path);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of await fs.readdir(path)) total += await size(join(path, entry));
  return total;
}
const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function postgres(platform, target) {
  const p = PLATFORMS[platform];
  const archive = await download(PINS.postgres.url(p.postgres), PINS.postgres.sha256[platform], `postgresql-${PINS.postgres.release}-${p.postgres}.tar.gz`);
  // The macOS/Linux archives hold library symlinks (libpq.so → libpq.so.5), which Windows cannot extract.
  if (process.platform === "win32" && p.os !== "win32") {
    console.warn(`Skipping PostgreSQL for ${platform}: its archive (verified) has symlinks; build it on a macOS or Linux host.`);
    return;
  }
  const work = join(cache, "work", `postgres-${platform}`);
  await extract(archive, work);
  const src = await single(work);
  // Drop what a running database never loads: headers, docs, static libraries, build files,
  // PL/Python (and the Python runtime it bundles) and the LLVM JIT (the backend sets jit = off).
  await remove(join(src, "include"));
  await remove(join(src, "share", "doc"));
  for (const entry of await fs.readdir(join(src, "bin"))) {
    const base = entry.replace(/\.exe$/i, "");
    const program = p.exe ? entry.toLowerCase().endsWith(".exe") : true;
    if ((program && !POSTGRES_PROGRAMS.has(base)) || /python|^DLLs$|^Lib$/i.test(entry)) await remove(join(src, "bin", entry));
  }
  for (const entry of await fs.readdir(join(src, "lib"))) {
    if (/\.(a|lib)$|^pgxs$|^pkgconfig$|python|^llvmjit|^bitcode$|libLLVM/i.test(entry)) await remove(join(src, "lib", entry));
  }
  await remove(join(target, "postgres"));
  await fs.rename(src, join(target, "postgres"));
  await remove(work);
}

async function postgrest(platform, target) {
  const p = PLATFORMS[platform];
  const archive = await download(PINS.postgrest.url(p.postgrest), PINS.postgrest.sha256[platform], `postgrest-${PINS.postgrest.version}-${p.postgrest}`);
  await extract(archive, join(target, "postgrest"));
  const binary = join(target, "postgrest", `postgrest${p.exe}`);
  if (!existsSync(binary)) throw new Error(`PostgREST archive for ${platform} has no postgrest${p.exe}`);
  // The macOS releases link Homebrew's libpq by absolute path (/opt/homebrew/opt/libpq/... on arm64,
  // /usr/local/opt/libpq/... on x64). Point it at the bundled one; DYLD_* variables would not help
  // once the binary is signed with the hardened runtime. Needs install_name_tool, so a macOS host.
  if (p.os === "darwin") {
    const homebrew = { arm64: "/opt/homebrew/opt/libpq/lib/libpq.5.dylib", x64: "/usr/local/opt/libpq/lib/libpq.5.dylib" }[p.arch];
    if (process.platform !== "darwin") console.warn(`PostgREST for ${platform} still links ${homebrew}; run this on macOS to relink it.`);
    else {
      run("install_name_tool", ["-change", homebrew, "@executable_path/../postgres/lib/libpq.5.dylib", binary]);
      run("codesign", ["--force", "--sign", "-", binary]);
    }
  }
}

async function mkcert(platform, target) {
  const p = PLATFORMS[platform];
  const file = await download(PINS.mkcert.url(p.mkcert), PINS.mkcert.sha256[platform], `mkcert-${PINS.mkcert.version}-${p.mkcert}`);
  await fs.copyFile(file, join(target, `mkcert${p.exe}`));
  await fs.chmod(join(target, `mkcert${p.exe}`), 0o755);
}

async function goToolchain() {
  const host = { win32: "windows", darwin: "darwin", linux: "linux" }[process.platform];
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  const asset = `${host}-${arch}.${host === "windows" ? "zip" : "tar.gz"}`;
  if (!PINS.go.sha256[asset]) throw new Error(`No pinned Go toolchain for ${asset}`);
  const dir = join(cache, `${PINS.go.version}-${host}-${arch}`);
  const go = join(dir, "go", "bin", `go${host === "windows" ? ".exe" : ""}`);
  if (!existsSync(go)) {
    const archive = await download(`https://go.dev/dl/${PINS.go.version}.${asset}`, PINS.go.sha256[asset], `${PINS.go.version}.${asset}`);
    await extract(archive, dir);
  }
  return go;
}

async function source(pin, name) {
  const archive = await download(pin.url, pin.sha256, `${name}-${pin.version}.tar.gz`);
  const dir = join(cache, "src", `${name}-${pin.version}`);
  const marker = join(dir, ".moneo-extracted");
  if (!existsSync(marker)) {
    await extract(archive, dir);
    await fs.writeFile(marker, pin.sha256);
  }
  return join(dir, pin.folder);
}

// GoTrue's HTTP listener sets SO_REUSEPORT through golang.org/x/sys/unix, which does not compile for
// Windows (and Windows has no SO_REUSEPORT; GoTrue uses it only for overlapping restarts). For the
// Windows build only, a `go build -overlay` swaps in a copy of cmd/serve_cmd.go without that call;
// the source tree and every other platform stay upstream.
async function gotrueWindowsOverlay(p, src) {
  if (p.goos !== "windows") return [];
  const file = join(src, "cmd", "serve_cmd.go");
  const original = await fs.readFile(file, "utf8");
  const call = "serr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEPORT, 1) // #nosec G115";
  const imported = '\t"golang.org/x/sys/unix"\n';
  if (!original.includes(call) || !original.replaceAll("\r\n", "\n").includes(imported)) throw new Error(`${file} changed; update the Windows overlay`);
  const patched = original.replaceAll("\r\n", "\n").replace(imported, "").replace(call, "_ = fd // no SO_REUSEPORT on Windows (Moneo Desktop build overlay)");
  const dir = join(cache, "work", "gotrue-windows-overlay");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "serve_cmd.go"), patched);
  await fs.writeFile(join(dir, "overlay.json"), JSON.stringify({ Replace: { [file]: join(dir, "serve_cmd.go") } }));
  return ["-overlay", join(dir, "overlay.json")];
}

async function gotrue(platform, target) {
  const p = PLATFORMS[platform];
  const go = await goToolchain();
  const src = await source(PINS.gotrue, "auth");
  const dest = join(target, "gotrue");
  await remove(dest);
  await fs.mkdir(dest, { recursive: true });
  console.log(`Building GoTrue ${PINS.gotrue.version} for ${p.goos}/${p.goarch}`);
  run(go, ["build", "-o", join(dest, `auth${p.exe}`), "-buildvcs=false", "-trimpath", ...await gotrueWindowsOverlay(p, src),
    "-ldflags", `-s -w -X github.com/supabase/auth/internal/utilities.Version=${PINS.gotrue.version}`, "."], {
    cwd: src,
    env: { ...process.env, CGO_ENABLED: "0", GOOS: p.goos, GOARCH: p.goarch, GOTOOLCHAIN: "local", GOFLAGS: "-mod=readonly",
      GOPATH: join(cache, "gopath"), GOMODCACHE: join(cache, "gopath", "pkg", "mod"), GOCACHE: join(cache, "gocache") },
  });
  await fs.cp(join(src, "migrations"), join(dest, "migrations"), { recursive: true });
  await fs.copyFile(join(src, "LICENSE"), join(dest, "LICENSE"));
}

function npm(npmArgs, cwd) {
  // npm is npm.cmd on Windows, which spawn only runs through a shell.
  run("npm", npmArgs, { cwd, shell: process.platform === "win32" });
}

async function nativeModules(dir, found = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await nativeModules(path, found);
    else if (entry.name === "binding.gyp" || entry.name.endsWith(".node")) found.push(path);
  }
  return found;
}

// supabase/storage built like its Dockerfile: npm ci without install scripts, esbuild into dist/,
// then a production-only install. Storage's file backend imports fs-xattr, a native addon that
// refuses to install on Windows; it is replaced by scripts/desktop/backend-fs-xattr-shim so this
// folder is the same on every platform, and the macOS/Linux addon is built per platform.
async function storage() {
  const src = await source(PINS.storage, "storage");
  const dest = join(out, "storage-api");
  const stamp = join(dest, ".moneo-build.json");
  const shim = join(import.meta.dirname, "backend-fs-xattr-shim");
  const wanted = JSON.stringify({ version: PINS.storage.version, sha256: PINS.storage.sha256, shim: await fs.readFile(join(shim, "index.js"), "utf8") });
  if (existsSync(stamp) && await fs.readFile(stamp, "utf8") === wanted) return console.log("Storage API is up to date.");
  const flags = ["--ignore-scripts", "--engine-strict=false", "--force", "--no-audit", "--no-fund"];
  console.log(`Building Storage API ${PINS.storage.version}`);
  npm(["ci", ...flags], src);
  run(process.execPath, ["build.js"], { cwd: src });
  const staging = `${dest}.partial`;
  await remove(staging);
  await fs.mkdir(staging, { recursive: true });
  for (const file of ["package.json", "package-lock.json", ".npmrc", "LICENSE"]) await fs.copyFile(join(src, file), join(staging, file));
  npm(["ci", "--omit=dev", ...flags], staging);
  await fs.cp(join(src, "dist"), join(staging, "dist"), { recursive: true });
  await fs.cp(join(src, "migrations"), join(staging, "migrations"), { recursive: true });
  // Source maps and declaration files are not needed to run it.
  for (const file of await fs.readdir(join(staging, "dist"), { recursive: true })) if (file.endsWith(".map")) await fs.rm(join(staging, "dist", file));
  await remove(join(staging, "node_modules", "fs-xattr"));
  await fs.cp(shim, join(staging, "node_modules", "fs-xattr"), { recursive: true });
  const natives = await nativeModules(join(staging, "node_modules"));
  if (natives.length) console.warn(`Native files left in storage-api node_modules:\n  ${natives.join("\n  ")}`);
  await remove(dest);
  await fs.rename(staging, dest);
  await fs.writeFile(stamp, wanted);
  console.log(`Storage API: ${mb(await size(dest))}`);
}

// The fs-xattr N-API addon for macOS/Linux, loaded by the shim through MONEO_FS_XATTR_ADDON.
async function xattrAddon(platform, target) {
  const p = PLATFORMS[platform];
  if (p.os === "win32") return;
  if (process.platform !== p.os || process.arch !== p.arch) {
    console.warn(`Skipping the fs-xattr addon for ${platform}: it only builds on a ${platform} host.`);
    return;
  }
  const work = join(cache, "work", "fs-xattr");
  await remove(work);
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(join(work, "package.json"), JSON.stringify({ private: true, dependencies: { "fs-xattr": "0.4.0" } }));
  npm(["install", "--no-audit", "--no-fund"], work);
  await fs.mkdir(join(target, "fs-xattr"), { recursive: true });
  await fs.copyFile(join(work, "node_modules", "fs-xattr", "build", "Release", "xattr.node"), join(target, "fs-xattr", "xattr.node"));
  await fs.copyFile(join(work, "node_modules", "fs-xattr", "LICENSE"), join(target, "fs-xattr", "LICENSE"));
}

async function syncSql() {
  for (const [from, to] of [[join(root, "supabase", "migrations"), join(out, "migrations")], [join(root, "desktop", "bootstrap"), join(out, "bootstrap")]]) {
    await remove(to);
    await fs.cp(from, to, { recursive: true });
  }
}

const { platforms, skip } = args();
await syncSql();
if (!skip.has("storage")) await storage();
for (const platform of platforms) {
  const target = join(out, "backend", platform);
  await fs.mkdir(target, { recursive: true });
  console.log(`\n== ${platform}`);
  if (!skip.has("postgres")) await postgres(platform, target);
  if (!skip.has("postgrest")) await postgrest(platform, target);
  if (!skip.has("gotrue")) await gotrue(platform, target);
  if (!skip.has("mkcert")) await mkcert(platform, target);
  if (!skip.has("storage")) await xattrAddon(platform, target);
  const manifest = {
    platform,
    postgres: { version: PINS.postgres.version, release: PINS.postgres.release, sha256: PINS.postgres.sha256[platform] },
    postgrest: { version: PINS.postgrest.version, sha256: PINS.postgrest.sha256[platform] },
    gotrue: { version: PINS.gotrue.version, commit: PINS.gotrue.commit, sha256: PINS.gotrue.sha256 },
    storage: { version: PINS.storage.version, commit: PINS.storage.commit, sha256: PINS.storage.sha256 },
    mkcert: { version: PINS.mkcert.version, sha256: PINS.mkcert.sha256[platform] },
  };
  await fs.writeFile(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const part of ["postgres", "postgrest", "gotrue", `mkcert${PLATFORMS[platform].exe}`, "fs-xattr"])
    if (existsSync(join(target, part))) console.log(`  ${part}: ${mb(await size(join(target, part)))}`);
  console.log(`  total: ${mb(await size(target))}`);
}
