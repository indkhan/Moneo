// The bundled PostgreSQL cluster: initdb on first run, start and stop through pg_ctl (which on
// Windows also drops administrator rights, as postgres.exe requires), stale postmaster.pid recovery.
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { exe, isAlive, mustRun, processName, runProgram } from "./processes";

export type Cluster = { bin: string; data: string; logs: string; port: number; password: string };

const program = (cluster: Pick<Cluster, "bin">, name: string) => path.join(cluster.bin, `${name}${exe}`);

export const isInitialized = (data: string) => existsSync(path.join(data, "PG_VERSION"));

export async function bundledMajor(bin: string) {
  const output = await mustRun(program({ bin }, "postgres"), ["--version"]);
  const major = output.match(/PostgreSQL\)\s+(\d+)/)?.[1];
  if (!major) throw new Error(`Could not read the bundled PostgreSQL version from "${output.trim()}"`);
  return major;
}

// The cluster's major version must match the bundled server; a major upgrade needs pg_upgrade.
export async function checkMajor(cluster: Cluster) {
  const data = (await fs.readFile(path.join(cluster.data, "PG_VERSION"), "utf8")).trim();
  const bundled = await bundledMajor(cluster.bin);
  if (data !== bundled) throw new Error(`The database was created by PostgreSQL ${data}, but this Moneo bundles PostgreSQL ${bundled}. Install the matching Moneo version or restore a backup.`);
}

// Like the Supabase image: UTF8, ICU collation en-US, scram-sha-256, superuser supabase_admin with
// POSTGRES_PASSWORD. Only TCP connections from 127.0.0.1 are accepted.
export async function initCluster(cluster: Cluster, home: string) {
  await fs.mkdir(path.dirname(cluster.data), { recursive: true });
  const pwfile = path.join(home, `.initdb-${process.pid}`);
  await fs.writeFile(pwfile, cluster.password, { mode: 0o600 });
  try {
    // libc locale for messages and number formats; ICU decides collation. Windows names it en-US,
    // macOS/Linux en_US.UTF-8, with C.UTF-8 and C as fallbacks on minimal Linux systems.
    const locales = process.platform === "win32" ? ["en-US"] : ["en_US.UTF-8", "C.UTF-8", "C"];
    let failure = "";
    for (const locale of locales) {
      await fs.rm(cluster.data, { recursive: true, force: true });
      const result = await runProgram(program(cluster, "initdb"), ["-D", cluster.data, "-U", "supabase_admin", `--pwfile=${pwfile}`,
        "--auth=scram-sha-256", "-E", "UTF8", "--locale-provider=icu", "--icu-locale=en-US", `--locale=${locale}`], { timeoutMs: 180_000 });
      if (result.code === 0) { failure = ""; break; }
      failure = result.output;
    }
    if (failure) throw new Error(`initdb failed:\n${failure.trim()}`);
  } finally {
    await fs.rm(pwfile, { force: true });
  }
  await fs.writeFile(path.join(cluster.data, "pg_hba.conf"),
    "# Moneo Desktop: password logins over TCP from this computer only; no Unix sockets.\n" +
    "# TYPE  DATABASE  USER  ADDRESS       METHOD\nhost    all       all   127.0.0.1/32  scram-sha-256\n");
  const conf = path.join(cluster.data, "postgresql.conf");
  await fs.appendFile(conf, "\n# Moneo Desktop settings, rewritten at every start.\ninclude 'moneo.conf'\n");
}

// Settings that differ from initdb's defaults. The Supabase image's values are kept where they
// change query results (UTC, extra_float_digits = 0, row_security, english text search).
async function writeSettings(cluster: Cluster) {
  const logs = cluster.logs.replaceAll("\\", "/").replaceAll("'", "''");
  await fs.writeFile(path.join(cluster.data, "moneo.conf"), [
    "listen_addresses = '127.0.0.1'",
    `port = ${cluster.port}`,
    "unix_socket_directories = ''",
    "password_encryption = scram-sha-256",
    "timezone = 'UTC'",
    "log_timezone = 'UTC'",
    "datestyle = 'iso, mdy'",
    "row_security = on",
    "extra_float_digits = 0",
    "default_text_search_config = 'pg_catalog.english'",
    "jit = off",
    "logging_collector = on",
    `log_directory = '${logs}'`,
    "log_filename = 'postgres-%a.log'",
    "log_truncate_on_rotation = on",
    "log_rotation_age = 1d",
    "log_rotation_size = 0",
    "log_line_prefix = '%m [%p] %q%u@%d '",
    "",
  ].join("\n"));
}

async function postmasterPid(data: string) {
  const text = await fs.readFile(path.join(data, "postmaster.pid"), "utf8").catch(() => "");
  const pid = Number(text.split("\n")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

// A postmaster.pid left by a crash: stop the server if it is still ours, delete the file if the
// process is gone or the PID now belongs to another program (postgres would refuse to start).
export async function recoverStalePid(cluster: Cluster, log: (line: string) => void) {
  const pid = await postmasterPid(cluster.data);
  if (!pid) return;
  const name = await processName(pid);
  if (name === `postgres${exe}`) {
    log(`PostgreSQL (pid ${pid}) is still running from an earlier session; restarting it`);
    await stopCluster(cluster);
  } else {
    log(`Removing stale postmaster.pid (pid ${pid} is ${name ? `now ${name}` : "gone"})`);
    await fs.rm(path.join(cluster.data, "postmaster.pid"), { force: true });
  }
}

export async function startCluster(cluster: Cluster, log: (line: string) => void) {
  await fs.mkdir(cluster.logs, { recursive: true });
  await recoverStalePid(cluster, log);
  if (await postmasterPid(cluster.data)) throw new Error("PostgreSQL is still running from an earlier session and did not stop");
  await writeSettings(cluster);
  const { code, output } = await runProgram(program(cluster, "pg_ctl"),
    ["start", "-D", cluster.data, "-w", "-t", "120", "-l", path.join(cluster.logs, "postgres-start.log")], { timeoutMs: 150_000 });
  if (code !== 0) {
    const startLog = await fs.readFile(path.join(cluster.logs, "postgres-start.log"), "utf8").catch(() => "");
    throw new Error(`PostgreSQL did not start (pg_ctl exit ${code}):\n${output.trim()}\n${startLog.split("\n").slice(-15).join("\n")}`);
  }
  const pid = await postmasterPid(cluster.data);
  if (!pid) throw new Error("PostgreSQL started but wrote no postmaster.pid");
  return pid;
}

export async function stopCluster(cluster: Pick<Cluster, "bin" | "data">) {
  if (!(await postmasterPid(cluster.data))) return;
  const { code, output } = await runProgram(program(cluster, "pg_ctl"), ["stop", "-D", cluster.data, "-m", "fast", "-w", "-t", "60"], { timeoutMs: 90_000 });
  // pg_ctl exits 1 with "PID file ... does not exist" / "Is server running?" when it already stopped.
  if (code !== 0 && !/does not exist|not running/i.test(output)) throw new Error(`pg_ctl stop failed (exit ${code}): ${output.trim()}`);
}

export async function runningPid(data: string) {
  const pid = await postmasterPid(data);
  return pid && isAlive(pid) ? pid : undefined;
}

export const pgProgram = program;
