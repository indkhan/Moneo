// End-to-end check of desktop/src/backend under plain Node (no Electron), against the binaries in
// desktop/.build (node scripts/desktop/fetch-backend.mjs first). Everything runs in a temporary
// home on its own ports; nothing touches .env, Docker or the owner's backend.
//   node scripts/desktop/backend-smoke.mjs [--keep]      (--keep leaves the temp homes for inspection)
// Checks: first start with all but the newest migration, then an upgrade start (pre-upgrade backup,
// the last migration applied), owner sign-in, RLS through PostgREST, Storage upload/download through
// the gateway, pgcrypto and pg_trgm, refusing a database from a newer Moneo, backup and restore into
// a fresh home, and that stop leaves no process or port behind. Also a force-quit: the backend runs
// in a child Node process that is killed hard; the next start ends what it left running (and only
// that) and runs without duplicates. On Windows, Postgres and PostgREST must load the app-local
// MSVC runtime DLLs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { built, loadBackend, root } from "./backend-load.mjs";

const keep = process.argv.includes("--keep");
const work = mkdtempSync(path.join(os.tmpdir(), "moneo-desktop-smoke-"));
console.log(`Working in ${work}`);
const backend = await loadBackend(work);

// Resources whose migrations folder can lag behind, to exercise the upgrade path.
async function resources(name, migrations) {
  const dir = path.join(work, name);
  await fs.mkdir(path.join(dir, "migrations"), { recursive: true });
  for (const part of ["backend", "storage-api", "bootstrap"]) await fs.symlink(path.join(built, part), path.join(dir, part), "junction");
  for (const file of migrations) await fs.copyFile(path.join(built, "migrations", file), path.join(dir, "migrations", file));
  return dir;
}

const all = readdirSync(path.join(built, "migrations")).filter(file => file.endsWith(".sql")).sort();
const older = await resources("resources-older", all.slice(0, -1));
const current = await resources("resources", all);
const home = path.join(work, "home");
const progress = step => { if (step.state !== "running") console.log(`  [${step.state}] ${step.label}${step.detail ? `: ${step.detail}` : ""}`); };
const pass = message => console.log(`PASS ${message}`);

async function json(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function signIn(env) {
  const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email: env.MONEO_OWNER_EMAIL, password: env.MONEO_OWNER_PASSWORD }),
  });
  const body = await json(response);
  assert.equal(response.status, 200, `owner sign-in: ${JSON.stringify(body)}`);
  return body;
}

const rest = (env, table, token) => fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${table}`, {
  headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${token ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}` },
}).then(json);

function servicePids(home) {
  return fs.readFile(path.join(home, "run", "services.json"), "utf8").then(JSON.parse).catch(() => []);
}
async function postmasterPid(home) {
  const text = await fs.readFile(path.join(home, "postgres", "postmaster.pid"), "utf8").catch(() => "");
  return Number(text.split("\n")[0]) || undefined;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (what, check, ms) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
};
const bundleDir = realpathSync.native(path.join(built, "backend"));
const platformKey = { "win32-x64": "win-x64", "darwin-arm64": "mac-arm64", "darwin-x64": "mac-x64", "linux-x64": "linux-x64" }[`${process.platform}-${process.arch}`];
const exeSuffix = process.platform === "win32" ? ".exe" : "";
const decoys = [];
const output = (file, args) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  let text = "";
  child.stdout.on("data", chunk => { text += chunk; });
  child.once("error", reject);
  child.once("exit", () => resolve(text));
});

// Processes whose executable is in desktop/.build/backend (also when started through the smoke's
// junctions): pid, parent pid, executable, command line.
const real = file => { try { return realpathSync.native(file); } catch { return file; } };
const inBundle = exe => /^(postgres|postgrest|auth)(\.exe)?$/i.test(path.basename(exe))
  && real(exe).toLowerCase().startsWith(bundleDir.toLowerCase() + path.sep);
async function bundleProcesses() {
  if (process.platform === "win32") {
    const text = await output("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"]);
    return JSON.parse(text).map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId, exe: p.ExecutablePath, args: p.CommandLine ?? "" }))
      .filter(p => inBundle(p.exe));
  }
  const text = await output("ps", ["-axo", "pid=,ppid=,comm=,args="]);
  return text.split("\n").map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, exe, args]) => ({ pid: Number(pid), ppid: Number(ppid), exe, args })).filter(p => inBundle(p.exe));
}

// Windows: which copies of the MSVC runtime a process has loaded.
async function msvcModules(pid) {
  const filter = "$_.ModuleName -match '^(vcruntime140|vcruntime140_1|msvcp140)\\.dll$'";
  const text = await output("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-Process -Id ${pid}).Modules | Where-Object { ${filter} } | Select-Object ModuleName,FileName | ConvertTo-Json -Compress`]);
  const parsed = text.trim() ? JSON.parse(text) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function stopAndCheck(running, home) {
  const pids = [...(await servicePids(home)).map(entry => entry.pid), await postmasterPid(home)].filter(Boolean);
  const { NEXT_PUBLIC_SUPABASE_URL: api, SUPABASE_DB_URL: db } = running.env;
  await running.stop();
  const left = pids.filter(alive);
  assert.deepEqual(left, [], `processes still running after stop: ${left.join(", ")}`);
  await assert.rejects(fetch(api, { signal: AbortSignal.timeout(2000) }), "gateway port still answers after stop");
  const sql = postgres(db, { max: 1, connect_timeout: 3, onnotice: () => {} });
  await assert.rejects(sql`select 1`, "database still accepts connections after stop");
  await sql.end({ timeout: 1 }).catch(() => {});
  pass(`stop ended ${pids.length} processes (${pids.join(", ")}) and closed the ports`);
}

let running;
try {
  // 1. First run with all but the newest migration.
  console.log("\n== First start (older bundle)");
  let started = Date.now();
  running = await backend.startBackend({ resources: older, home }, progress);
  console.log(`  ready in ${((Date.now() - started) / 1000).toFixed(1)} s at ${running.env.NEXT_PUBLIC_SUPABASE_URL}`);
  const config = JSON.parse(await fs.readFile(path.join(home, "config.json"), "utf8"));
  assert.ok(config.bootstrapped && config.secrets.JWT_SECRET && config.secrets.SUPABASE_SERVICE_ROLE_KEY);
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(home, "config.json"))).mode & 0o777, 0o600);
  await stopAndCheck(running, home);
  running = undefined;

  // 2. Force-quit: the backend runs in a child Node process, which is killed hard.
  console.log("\n== Force-quit (child runner killed hard)");
  const runner = spawn(process.execPath, [path.join(root, "scripts", "desktop", "backend-run.mjs"), "--home", home, "--resources", older],
    { stdio: ["ignore", "ignore", "inherit"], windowsHide: true });
  const runnerExit = new Promise(resolve => runner.once("exit", resolve));
  await until("the child backend", () => existsSync(path.join(home, "run", "env.json")), 180_000);
  const left = Object.fromEntries((await servicePids(home)).map(entry => [entry.service, entry.pid]));
  const oldPostmaster = await postmasterPid(home);
  runner.kill("SIGKILL");
  await runnerExit;
  // pg_ctl's server always outlives its parent. On Windows, libuv puts spawned children in a
  // kill-on-close job, so GoTrue and PostgREST end with the parent; elsewhere they are left running.
  assert.ok(alive(oldPostmaster), "postgres should outlive a force-quit");
  if (process.platform !== "win32") assert.ok(alive(left.auth) && alive(left.rest), "GoTrue and PostgREST should outlive a force-quit here");
  await until("Storage to exit after its parent died", () => !alive(left.storage), 10_000);
  pass(`force-quit left postgres ${oldPostmaster} running (GoTrue ${alive(left.auth) ? "running" : "ended"}, PostgREST ${alive(left.rest) ? "running" : "ended"}); Storage exited by itself`);

  // Two planted records prove the recovery checks before it kills: a detached PostgREST from the
  // bundle (must be ended) and an unrelated process recorded under GoTrue's path (must be left alone).
  const decoyRest = spawn(path.join(older, "backend", platformKey, "postgrest", `postgrest${exeSuffix}`), [], {
    detached: true, stdio: "ignore", windowsHide: true,
    env: { ...process.env, PATH: `${path.join(older, "backend", platformKey, "postgres", "bin")}${path.delimiter}${process.env.PATH}`,
      PGRST_DB_URI: "postgresql://nobody@127.0.0.1:1/nothing", PGRST_SERVER_HOST: "127.0.0.1", PGRST_SERVER_PORT: "0" },
  });
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", windowsHide: true });
  decoys.push(decoyRest.pid, sleeper.pid);
  await until("the decoy PostgREST", () => alive(decoyRest.pid), 5000);
  await fs.writeFile(path.join(home, "run", "services.json"), JSON.stringify([...await servicePids(home),
    { service: "rest", pid: decoyRest.pid, exe: path.join(older, "backend", platformKey, "postgrest", `postgrest${exeSuffix}`) },
    { service: "auth", pid: sleeper.pid, exe: path.join(older, "backend", platformKey, "gotrue", `auth${exeSuffix}`) }]));

  // 3. Upgrade start in the same home: ends the leftovers, then one pending migration → automatic
  // pre-upgrade backup, then applied.
  console.log("\n== Upgrade start after the force-quit (current bundle)");
  started = Date.now();
  running = await backend.startBackend({ resources: current, home }, progress);
  console.log(`  ready in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const { env } = running;
  const gone = [oldPostmaster, ...Object.values(left), decoyRest.pid].filter(alive);
  assert.deepEqual(gone, [], `leftovers still running: ${gone.join(", ")}`);
  assert.ok(alive(sleeper.pid), "a recorded PID that is not the recorded program must be left alone");
  process.kill(sleeper.pid);
  pass(`recovery ended the old postmaster and the planted bundled PostgREST (${decoyRest.pid}), and left the unrelated process (${sleeper.pid}) alone`);
  const newPostmaster = await postmasterPid(home);
  const processes = await bundleProcesses();
  assert.deepEqual(processes.filter(p => p.ppid === runner.pid), [], "nothing started by the killed runner may survive");
  const dataDir = path.join(home, "postgres").replaceAll("\\", "/").toLowerCase();
  const postmasters = processes.filter(p => /postgres(\.exe)?$/i.test(p.exe) && p.args.replaceAll("\\", "/").toLowerCase().includes(dataDir));
  assert.deepEqual(postmasters.map(p => p.pid), [newPostmaster], `one postmaster for this data folder: ${JSON.stringify(postmasters)}`);
  const suffix = process.platform === "win32" ? ".exe" : "";
  const mine = processes.filter(p => p.ppid === process.pid).map(p => path.basename(p.exe).toLowerCase()).sort();
  assert.deepEqual(mine, [`auth${suffix}`, `postgrest${suffix}`], `one GoTrue and one PostgREST: ${mine.join(", ")}`);
  pass(`after the force-quit: leftovers ended; one postmaster (${newPostmaster}) for this data folder, one GoTrue, one PostgREST`);

  if (process.platform === "win32") {
    const restPid = (await servicePids(home)).find(entry => entry.service === "rest").pid;
    for (const [name, pid] of [["postgres", newPostmaster], ["postgrest", restPid]]) {
      const modules = await msvcModules(pid);
      assert.ok(modules.some(m => m.ModuleName.toLowerCase() === "vcruntime140.dll"), `${name} did not load vcruntime140.dll`);
      for (const m of modules) assert.ok(realpathSync.native(m.FileName).toLowerCase().startsWith(bundleDir.toLowerCase()), `${name} loaded ${m.FileName}, not the app-local copy`);
      pass(`${name} (pid ${pid}) loaded the app-local MSVC runtime: ${modules.map(m => path.relative(bundleDir, realpathSync.native(m.FileName))).join(", ")}`);
    }
  }
  const backups = readdirSync(path.join(home, "backups"));
  assert.equal(backups.filter(name => name.endsWith("pre-upgrade")).length, 1, `pre-upgrade backup: ${backups.join(", ")}`);
  pass(`pending migration triggered backup ${backups[0]}`);

  const db = postgres(env.SUPABASE_DB_URL, { max: 1, onnotice: () => {} });
  try {
    const [{ count }] = await db`select count(*)::int as count from supabase_migrations.schema_migrations`;
    assert.equal(count, all.length);
    pass(`${count} of ${all.length} migrations applied`);
    const [role] = await db`select rolsuper, rolbypassrls from pg_roles where rolname = 'postgres'`;
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: true });
    const members = await db`select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid where m.member = 'postgres'::regrole and r.rolname in ('supabase_auth_admin', 'supabase_storage_admin')`;
    assert.equal(members.length, 0, "postgres must not keep the owner roles after migrations");
    pass("postgres is NOSUPERUSER BYPASSRLS like the image, without the migration-time owner roles");
    const [crypto] = await db`select encode(extensions.digest('moneo', 'sha256'), 'hex') as digest, length(extensions.gen_random_bytes(16)) as random, extensions.crypt('pw', extensions.gen_salt('bf')) like '$2a$%' as bcrypt`;
    assert.equal(crypto.digest, createHash("sha256").update("moneo").digest("hex"));
    assert.equal(crypto.random, 16);
    assert.equal(crypto.bcrypt, true);
    const [trgm] = await db`select extensions.similarity('Müllerstraße', 'Muellerstrasse') as similarity, extensions.show_trgm('Straße') as trigrams, 'Café Zürich' operator(extensions.%) 'Cafe Zurich' as fuzzy`;
    assert.ok(trgm.similarity > 0 && trgm.similarity < 1);
    pass(`pgcrypto (sha256 ${crypto.digest.slice(0, 12)}…, bcrypt) and pg_trgm (similarity ${trgm.similarity.toFixed(3)}, trigrams of 'Straße' ${JSON.stringify(trgm.trigrams)}, % ${trgm.fuzzy})`);
  } finally { await db.end(); }

  // Owner, RLS and Storage through the gateway.
  const session = await signIn(env);
  const owned = await rest(env, "workspaces?select=id,owner_id", session.access_token);
  assert.ok(Array.isArray(owned) && owned.length === 1 && owned[0].owner_id === session.user.id, `owner workspaces: ${JSON.stringify(owned)}`);
  const anonymous = await rest(env, "workspaces?select=id");
  assert.deepEqual(anonymous, [], `anon must see no workspaces: ${JSON.stringify(anonymous)}`);
  pass(`PostgREST: owner sees its workspace ${owned[0].id}, anon sees none (RLS)`);

  const workspace = owned[0].id;
  const object = `${workspace}/smoke/statement.csv`;
  const content = `date,amount\n2026-11-10,-1234\n${"x".repeat(200_000)}\n`;
  const storage = `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1`;
  const auth = { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${session.access_token}` };
  let response = await fetch(`${storage}/object/imports/${object}`, { method: "POST", headers: { ...auth, "content-type": "text/csv" }, body: content });
  const uploaded = await json(response);
  assert.equal(response.status, 200, `upload: ${JSON.stringify(uploaded)}`);
  response = await fetch(`${storage}/object/imports/${object}`, { headers: auth });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv");
  assert.equal(await response.text(), content);
  response = await fetch(`${storage}/object/imports/${object}`, { headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}` } });
  assert.ok(response.status >= 400, `anon download must fail, got ${response.status}`);
  await response.body?.cancel();
  pass(`Storage: ${content.length} bytes uploaded and downloaded as the owner with content-type text/csv; anon refused (${response.status})`);

  // 4. Manual backup while running, stop, restore into a fresh home, check the data came along.
  const folder = await backend.backup({ resources: current, home }, "smoke");
  const manifest = JSON.parse(await fs.readFile(path.join(folder, "manifest.json"), "utf8"));
  assert.equal(manifest.automatic, false);
  pass(`backup ${path.basename(folder)} (${((await fs.stat(path.join(folder, "database.dump"))).size / 1024).toFixed(0)} KB dump)`);
  await stopAndCheck(running, home);
  running = undefined;

  console.log("\n== Restore into a fresh home");
  const restored = path.join(work, "home-restored");
  await backend.restore({ resources: current, home: restored }, folder);
  running = await backend.startBackend({ resources: current, home: restored }, progress);
  const again = await signIn(running.env);
  assert.equal(again.user.id, session.user.id);
  const workspaces = await rest(running.env, "workspaces?select=id", again.access_token);
  assert.deepEqual(workspaces.map(row => row.id), [workspace]);
  response = await fetch(`${running.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/imports/${object}`, { headers: { apikey: running.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${again.access_token}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv");
  assert.equal(await response.text(), content);
  assert.equal(readdirSync(path.join(restored, "backups")).length, 0, "an upgrade-free restore needs no automatic backup");
  pass("restored home: same owner, same workspace, same file and content type");

  // 5. A database from a newer Moneo is refused before any service starts.
  const db2 = postgres(running.env.SUPABASE_DB_URL, { max: 1, onnotice: () => {} });
  await db2`insert into supabase_migrations.schema_migrations (version, name) values ('299901010001', 'from_the_future')`;
  await db2.end();
  await stopAndCheck(running, restored);
  running = undefined;
  await assert.rejects(backend.startBackend({ resources: current, home: restored }, () => {}), /newer Moneo/);
  assert.equal(await postmasterPid(restored), undefined, "postgres must be stopped after a refused start");
  pass("a database with a newer migration is refused and postgres is stopped again");

  console.log("\nAll backend smoke checks passed.");
} finally {
  if (running) await running.stop().catch(error => console.error(`stop: ${error.message}`));
  // After a failed check: end what this run started and may have left (decoys, a force-quit's server).
  for (const pid of decoys) if (alive(pid)) process.kill(pid);
  for (const dir of [home, path.join(work, "home-restored")]) {
    if (await postmasterPid(dir) && alive(await postmasterPid(dir)))
      await output(path.join(built, "backend", platformKey, "postgres", "bin", `pg_ctl${exeSuffix}`), ["stop", "-D", path.join(dir, "postgres"), "-m", "fast", "-w"]);
  }
  if (!keep) await fs.rm(work, { recursive: true, force: true }).catch(error => console.error(`Could not remove ${work}: ${error.message}`));
}
