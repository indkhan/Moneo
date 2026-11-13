// Moneo Desktop's native backend: PostgreSQL, GoTrue, PostgREST and the Storage API running on
// 127.0.0.1 behind one gateway, in place of docker-compose.yml. See README.md for the layout and
// for where this differs from the Docker backend.
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, type WriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readManifest, restoreDump, writeBackup } from "./backup";
import { newConfig, readConfig, writeConfig, type Config } from "./config";
import { startGateway } from "./gateway";
import { applyMigrations, bootstrap, bootstrapFiles, bundledMigrations, connect, createOwner, migrationState, revokeMigrationOwners } from "./migrations";
import { bundledMajor, checkMajor, initCluster, isInitialized, recoverStalePid, runningPid, startCluster, stopCluster, type Cluster } from "./postgres";
import { defaultFork, exe, freePort, httpOk, isAlive, openLog, PidFile, pipeTo, platformKey, preferredPort, spawnService, waitFor, type ForkFn, type ForkedProcess } from "./processes";

export type { ForkFn, ForkedProcess } from "./processes";
export type BackendPaths = { resources: string; home: string };
export type Progress = (step: { id: string; label: string; state: "running" | "done" | "error"; detail?: string }) => void;
export type RunningBackend = {
  env: Record<string, string>;
  stop(): Promise<void>;
  onExit(cb: (service: string, code: number | null) => void): void;
};
export type StartOptions = {
  // Starts the Storage API (a Node app); the default uses Electron's utilityProcess when in Electron.
  fork?: ForkFn;
  // The app's address, for GoTrue's redirect allow-list. Moneo signs in with a password, so it is
  // only used for links GoTrue would send.
  appUrl?: string;
  appVersion?: string;
};

function layout(paths: BackendPaths) {
  const backend = path.join(paths.resources, "backend", platformKey());
  return {
    backend,
    pgBin: path.join(backend, "postgres", "bin"),
    pgLib: path.join(backend, "postgres", "lib"),
    postgrest: path.join(backend, "postgrest", `postgrest${exe}`),
    gotrue: path.join(backend, "gotrue", `auth${exe}`),
    gotrueMigrations: path.join(backend, "gotrue", "migrations"),
    xattrAddon: path.join(backend, "fs-xattr", "xattr.node"),
    storageApi: path.join(paths.resources, "storage-api"),
    storageServer: path.join(paths.resources, "storage-api", "server.js"),
    migrations: path.join(paths.resources, "migrations"),
    bootstrap: path.join(paths.resources, "bootstrap"),
    configFile: path.join(paths.home, "config.json"),
    data: path.join(paths.home, "postgres"),
    storage: path.join(paths.home, "storage"),
    logs: path.join(paths.home, "logs"),
    backups: path.join(paths.home, "backups"),
    workflow: path.join(paths.home, "workflow"),
    appData: path.join(paths.home, "data"),
    pids: path.join(paths.home, "run", "services.json"),
  };
}
type Layout = ReturnType<typeof layout>;

function checkResources(l: Layout) {
  const required = [path.join(l.pgBin, `postgres${exe}`), l.postgrest, l.gotrue, l.gotrueMigrations, l.storageServer, l.migrations, l.bootstrap];
  const missing = required.filter(file => !existsSync(file));
  if (missing.length) throw new Error(`The bundled backend is incomplete (run node scripts/desktop/fetch-backend.mjs): missing ${missing.join(", ")}`);
}

function bundledServices(l: Layout): Record<string, string> {
  const manifest = JSON.parse(readFileSync(path.join(l.backend, "manifest.json"), "utf8")) as Record<string, { version: string }>;
  return Object.fromEntries(["postgres", "postgrest", "gotrue", "storage"].map(name => [name, manifest[name]?.version ?? "unknown"]));
}

// Only what the services need from the parent environment, so Electron's own variables
// (NODE_OPTIONS, ELECTRON_*) never reach them.
function baseEnv(): Record<string, string> {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "LANG"];
  return Object.fromEntries(keep.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key] as string]));
}

const withPath = (env: Record<string, string>, dir: string) => {
  const key = Object.keys(env).find(name => name.toUpperCase() === "PATH") ?? "PATH";
  return { ...env, [key]: `${dir}${path.delimiter}${env[key] ?? ""}` };
};

type Service = { name: string; pid?: number; exited?: string; stop(): Promise<void> };

function track(name: string, child: ChildProcess | ForkedProcess, log: WriteStream, isStopping: () => boolean, onExit: (service: string, code: number | null) => void): Service {
  pipeTo(log, child);
  const service: Service = {
    name, pid: child.pid,
    async stop() {
      if (service.exited) return;
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill();
      const timeout = new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 10_000).unref());
      if (await Promise.race([exited, timeout]) === "timeout" && child.pid && isAlive(child.pid)) process.kill(child.pid, "SIGKILL");
    },
  };
  child.once("exit", (code: number | null) => {
    service.exited = `exit code ${code}`;
    log.write(`${new Date().toISOString()} ${name} exited (${code})\n`);
    if (!isStopping()) onExit(name, code);
  });
  return service;
}

export async function startBackend(paths: BackendPaths, progress: Progress, options: StartOptions = {}): Promise<RunningBackend> {
  const l = layout(paths);
  checkResources(l);
  for (const dir of [l.storage, l.logs, l.backups, l.workflow, l.appData]) await fs.mkdir(dir, { recursive: true });
  const backendLog = await openLog(l.logs, "backend");
  const note = (line: string) => backendLog.write(`${new Date().toISOString()} ${line}\n`);
  const step = async <T>(id: string, label: string, work: () => Promise<T>) => {
    progress({ id, label, state: "running" });
    note(`${label}…`);
    try {
      const result = await work();
      progress({ id, label, state: "done" });
      return result;
    } catch (error) {
      progress({ id, label, state: "error", detail: (error as Error).message });
      note(`${label} failed: ${(error as Error).stack ?? error}`);
      throw error;
    }
  };

  const fresh = !isInitialized(l.data);
  let config = await readConfig(l.configFile);
  if (!config) {
    if (!fresh) throw new Error(`${l.data} holds a database but ${l.configFile} is missing; its passwords and keys cannot be recovered. Restore a backup.`);
    config = newConfig();
  } else if (fresh && config.bootstrapped) {
    throw new Error(`${l.data} is missing although Moneo was set up here before. Restore a backup instead of starting empty.`);
  }
  if (options.appVersion) config.appVersion = options.appVersion;
  await writeConfig(l.configFile, config);
  const secrets = config.secrets;

  const pids = new PidFile(l.pids);
  await pids.killStale([l.backend, l.storageApi], note);
  const cluster: Cluster = { bin: l.pgBin, data: l.data, logs: path.join(l.logs, "postgres"), port: config.ports.db, password: secrets.POSTGRES_PASSWORD };
  if (!fresh) await recoverStalePid(cluster, note);
  config.ports.db = cluster.port = await preferredPort(config.ports.db);
  config.ports.api = await preferredPort(config.ports.api);
  await writeConfig(l.configFile, config);

  const listeners: ((service: string, code: number | null) => void)[] = [];
  let stopping = false;
  const emitExit = (service: string, code: number | null) => { note(`${service} stopped unexpectedly (${code})`); for (const cb of listeners) cb(service, code); };
  const services: Service[] = [];
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  let monitor: NodeJS.Timeout | undefined;
  const dbs: ReturnType<typeof connect>[] = [];
  const stop = async () => {
    stopping = true;
    clearInterval(monitor);
    await Promise.all(dbs.splice(0).map(db => db.end({ timeout: 5 }).catch(() => {})));
    for (const service of services.splice(0).reverse()) await service.stop().catch(error => note(`Stopping ${service.name}: ${error.message}`));
    await gateway?.close();
    await stopCluster(cluster).catch(error => note(`Stopping PostgreSQL: ${error.message}`));
    await fs.rm(l.pids, { force: true });
    note("Backend stopped");
    backendLog.end();
  };

  try {
    const postmaster = await step("database", fresh ? "Creating the database" : "Starting the database", async () => {
      if (fresh) await initCluster(cluster, paths.home);
      else await checkMajor(cluster);
      return startCluster(cluster, note);
    });
    monitor = setInterval(() => {
      if (!stopping && !isAlive(postmaster)) { clearInterval(monitor); emitExit("postgres", null); }
    }, 2000);
    monitor.unref();

    const admin = connect(cluster.port, "supabase_admin", secrets.POSTGRES_PASSWORD);
    const owner = connect(cluster.port, "postgres", secrets.POSTGRES_PASSWORD);
    dbs.push(admin, owner);
    if (!config.bootstrapped) {
      await step("bootstrap", "Setting up database roles", () => bootstrap(admin, l.bootstrap, bootstrapFiles(l.bootstrap), secrets.POSTGRES_PASSWORD, secrets.JWT_SECRET));
      config.bootstrapped = true;
      await writeConfig(l.configFile, config);
    }

    const bundled = bundledMigrations(l.migrations);
    const state = await migrationState(owner, bundled);
    if (state.newer.length)
      throw new Error(`This data was last used by a newer Moneo (database version ${state.newer.at(-1)}; this app knows up to ${bundled.at(-1)?.version}). Install the newer Moneo, or restore a backup made with this version.`);
    // A crash during migrations could leave postgres with the owner roles; take them back.
    await revokeMigrationOwners(admin);
    const versions = bundledServices(l);
    const servicesChanged = config.services !== undefined && JSON.stringify(config.services) !== JSON.stringify(versions);
    if (state.applied.length && (state.pending.length || servicesChanged)) {
      await step("backup", "Backing up before the update", () => writeBackup({
        backups: l.backups, storage: l.storage, config, configFile: l.configFile, cluster, reason: "pre-upgrade", automatic: true, postgresVersion: versions.postgres,
      }));
    }

    // Older desktop homes need the guard before PostgREST opens its sessions too.
    await admin.unsafe("ALTER ROLE authenticator SET session_preload_libraries TO 'safeupdate'");

    const apiUrl = `http://127.0.0.1:${config.ports.api}`;
    const [authPort, restPort, restAdminPort, storagePort, storageAdminPort] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    const base = baseEnv();
    const dbUrl = (user: string) => `postgresql://${user}:${encodeURIComponent(secrets.POSTGRES_PASSWORD)}@127.0.0.1:${cluster.port}/postgres`;
    const recordPids = () => pids.write(services.filter(s => s.pid).map(s => s.name === "storage"
      ? { service: s.name, pid: s.pid as number, exe: process.execPath, script: l.storageServer }
      : { service: s.name, pid: s.pid as number, exe: s.name === "auth" ? l.gotrue : l.postgrest }));

    await step("auth", "Starting sign-in (GoTrue)", async () => {
      const appUrl = options.appUrl ?? "http://localhost";
      const child = spawnService(l.gotrue, [], {
        ...base,
        API_EXTERNAL_URL: `${apiUrl}/auth/v1`,
        GOTRUE_API_HOST: "127.0.0.1",
        GOTRUE_API_PORT: String(authPort),
        GOTRUE_DB_DRIVER: "postgres",
        GOTRUE_DB_DATABASE_URL: dbUrl("supabase_auth_admin"),
        GOTRUE_DB_MIGRATIONS_PATH: l.gotrueMigrations,
        // GoTrue keeps no idle connections by default. A new Postgres connection costs 100+ ms on
        // Windows (a process per connection), which made every page's sign-in check take ~0.5 s.
        GOTRUE_DB_MAX_POOL_SIZE: "10",
        GOTRUE_DB_MAX_IDLE_POOL_SIZE: "5",
        GOTRUE_SITE_URL: appUrl,
        GOTRUE_URI_ALLOW_LIST: appUrl,
        GOTRUE_JWT_SECRET: secrets.JWT_SECRET,
        GOTRUE_JWT_EXP: "3600",
        GOTRUE_JWT_AUD: "authenticated",
        GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
        GOTRUE_JWT_ADMIN_ROLES: "service_role",
        GOTRUE_DISABLE_SIGNUP: "true",
        GOTRUE_EXTERNAL_EMAIL_ENABLED: "true",
        GOTRUE_MAILER_AUTOCONFIRM: "true",
        GOTRUE_EXTERNAL_PHONE_ENABLED: "false",
        GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false",
        GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: "true",
        GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: "10",
      }, path.dirname(l.gotrue));
      const service = track("auth", child, await openLog(l.logs, "auth"), () => stopping, emitExit);
      services.push(service);
      await recordPids();
      // GoTrue applies its own migrations before it answers /health.
      await waitFor("GoTrue", () => httpOk(`http://127.0.0.1:${authPort}/health`), 180_000, () => service.exited);
    });

    await step("storage", "Starting file storage", async () => {
      const fork = options.fork ?? defaultFork;
      const env: Record<string, string> = {
        ...base,
        NODE_ENV: "production",
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: String(storagePort),
        SERVER_ADMIN_PORT: String(storageAdminPort),
        DATABASE_URL: dbUrl("supabase_storage_admin"),
        ANON_KEY: secrets.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        SERVICE_KEY: secrets.SUPABASE_SERVICE_ROLE_KEY,
        AUTH_JWT_SECRET: secrets.JWT_SECRET,
        STORAGE_BACKEND: "file",
        FILE_STORAGE_BACKEND_PATH: l.storage,
        FILE_SIZE_LIMIT: "52428800",
        TENANT_ID: "stub",
        GLOBAL_S3_BUCKET: "stub",
        STORAGE_S3_REGION: "local",
        ENABLE_IMAGE_TRANSFORMATION: "false",
        // No Swagger docs: Moneo does not use them, and the bundled server has no package.json for them.
        EXPOSE_DOCS: "false",
        // The bundled server exits by itself once this process is gone (see fetch-backend.mjs).
        MONEO_PARENT_PID: String(process.pid),
      };
      if (process.platform !== "win32") env.MONEO_FS_XATTR_ADDON = l.xattrAddon;
      const child = fork(l.storageServer, [], { env, cwd: l.storageApi, serviceName: "Moneo Storage" });
      const service = track("storage", child, await openLog(l.logs, "storage"), () => stopping, emitExit);
      services.push(service);
      await recordPids();
      await waitFor("Storage API", () => httpOk(`http://127.0.0.1:${storagePort}/status`), 180_000, () => service.exited);
    });

    await step("rest", "Starting the data API (PostgREST)", async () => {
      let env: Record<string, string> = {
        ...base,
        PGRST_DB_URI: dbUrl("authenticator"),
        PGRST_DB_SCHEMAS: "public,graphql_public",
        PGRST_DB_EXTRA_SEARCH_PATH: "public,extensions",
        PGRST_DB_MAX_ROWS: "1000",
        PGRST_DB_ANON_ROLE: "anon",
        PGRST_JWT_SECRET: secrets.JWT_SECRET,
        PGRST_SERVER_HOST: "127.0.0.1",
        PGRST_SERVER_PORT: String(restPort),
        PGRST_ADMIN_SERVER_PORT: String(restAdminPort),
      };
      // PostgREST links libpq dynamically: LIBPQ.dll on Windows is found through PATH; on macOS
      // fetch-backend.mjs relinks it to postgres/lib (the fallback path only helps unsigned dev builds).
      if (process.platform === "win32") env = withPath(env, l.pgBin);
      if (process.platform === "darwin") env.DYLD_FALLBACK_LIBRARY_PATH = l.pgLib;
      const child = spawnService(l.postgrest, [], env, path.dirname(l.postgrest));
      const service = track("rest", child, await openLog(l.logs, "rest"), () => stopping, emitExit);
      services.push(service);
      await recordPids();
      await waitFor("PostgREST", () => httpOk(`http://127.0.0.1:${restAdminPort}/ready`), 60_000, () => service.exited);
    });

    gateway = await step("gateway", "Connecting the services", () => startGateway(config.ports.api, { auth: authPort, rest: restPort, storage: storagePort }, note));

    const applied = await step("migrate", "Updating the database", () => applyMigrations(admin, owner, l.migrations, state.pending, note));
    if (applied) {
      // PostgREST reloads its schema cache asynchronously after the notify.
      await waitFor("PostgREST schema reload", () => httpOk(`http://127.0.0.1:${restAdminPort}/ready`), 60_000);
    }
    await step("owner", "Preparing your account", () => createOwner(apiUrl, secrets.SUPABASE_SERVICE_ROLE_KEY, secrets.MONEO_OWNER_EMAIL, secrets.MONEO_OWNER_PASSWORD));

    config.schemaVersion = bundled.at(-1)?.version ?? config.schemaVersion;
    config.services = versions;
    await writeConfig(l.configFile, config);
    await Promise.all(dbs.splice(0).map(db => db.end({ timeout: 5 })));
    note(`Backend ready at ${apiUrl} (database port ${cluster.port}); ${applied} migration(s) applied`);

    return {
      env: {
        NEXT_PUBLIC_SUPABASE_URL: apiUrl,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: secrets.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        SUPABASE_SERVICE_ROLE_KEY: secrets.SUPABASE_SERVICE_ROLE_KEY,
        SUPABASE_DB_URL: dbUrl("postgres"),
        BANK_TOKEN_ENCRYPTION_KEY: secrets.BANK_TOKEN_ENCRYPTION_KEY,
        CRON_SECRET: secrets.CRON_SECRET,
        MONEO_OWNER_EMAIL: secrets.MONEO_OWNER_EMAIL,
        MONEO_OWNER_PASSWORD: secrets.MONEO_OWNER_PASSWORD,
        MONEO_DATA_DIR: l.appData,
        WORKFLOW_LOCAL_DATA_DIR: l.workflow,
      },
      stop,
      onExit: cb => { listeners.push(cb); },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function withCluster<T>(l: Layout, config: Config, work: (cluster: Cluster) => Promise<T>) {
  const cluster: Cluster = { bin: l.pgBin, data: l.data, logs: path.join(l.logs, "postgres"), port: config.ports.db, password: config.secrets.POSTGRES_PASSWORD };
  if (await runningPid(l.data)) return work(cluster);
  // Not running: start it just for this, on a free port, and stop it again.
  await recoverStalePid(cluster, () => {});
  cluster.port = await preferredPort(config.ports.db);
  await startCluster(cluster, () => {});
  try { return await work(cluster); } finally { await stopCluster(cluster); }
}

// Works while the backend runs (consistent pg_dump; Storage files are copied as they are) or
// while it is stopped (the database is started just for the dump).
export async function backup(paths: BackendPaths, reason: string, options: { automatic?: boolean } = {}): Promise<string> {
  const l = layout(paths);
  const config = await readConfig(l.configFile);
  if (!config || !isInitialized(l.data)) throw new Error("There is no Moneo database to back up yet");
  return withCluster(l, config, async cluster => writeBackup({
    backups: l.backups, storage: l.storage, config, configFile: l.configFile, cluster, reason, automatic: options.automatic ?? false, postgresVersion: await bundledMajor(l.pgBin),
  }));
}

// Replaces this home's database and files with a backup. The backend must be stopped. The current
// data is backed up first ("before-restore"), so a restore can itself be undone.
export async function restore(paths: BackendPaths, folder: string): Promise<void> {
  const l = layout(paths);
  checkResources(l);
  const manifest = await readManifest(folder);
  if (await runningPid(l.data)) throw new Error("Stop Moneo's backend before restoring a backup");
  const current = await readConfig(l.configFile);
  if (current && isInitialized(l.data)) await backup(paths, "before-restore", { automatic: false });
  const saved = JSON.parse(await fs.readFile(path.join(folder, manifest.files.config), "utf8")) as Config;
  const config: Config = { ...saved, ports: current?.ports ?? saved.ports, bootstrapped: false };
  await fs.rm(l.data, { recursive: true, force: true });
  await fs.rm(l.storage, { recursive: true, force: true });
  await writeConfig(l.configFile, config);
  const cluster: Cluster = { bin: l.pgBin, data: l.data, logs: path.join(l.logs, "postgres"), port: await preferredPort(config.ports.db), password: config.secrets.POSTGRES_PASSWORD };
  await initCluster(cluster, paths.home);
  await startCluster(cluster, () => {});
  try {
    const admin = connect(cluster.port, "supabase_admin", config.secrets.POSTGRES_PASSWORD);
    try {
      // Roles live outside the dump; schemas, extensions, data and grants come from pg_restore.
      await bootstrap(admin, l.bootstrap, ["00-roles.sql"], config.secrets.POSTGRES_PASSWORD, config.secrets.JWT_SECRET);
    } finally { await admin.end({ timeout: 5 }); }
    await restoreDump(cluster, path.join(folder, manifest.files.database));
  } finally {
    await stopCluster(cluster);
  }
  if (existsSync(path.join(folder, manifest.files.storage))) await fs.cp(path.join(folder, manifest.files.storage), l.storage, { recursive: true });
  else await fs.mkdir(l.storage, { recursive: true });
  await writeConfig(l.configFile, { ...config, bootstrapped: true, schemaVersion: manifest.schemaVersion, services: manifest.services });
}
