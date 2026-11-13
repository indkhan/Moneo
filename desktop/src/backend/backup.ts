// Backups: a pg_dump custom-format dump of the whole postgres database plus copies of the Storage
// files and config.json (the secrets the data needs: JWT secret, bank token key, owner login).
//   <home>/backups/<timestamp>-<reason>/{database.dump, storage/, config.json, manifest.json}
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config";
import { pgProgram, type Cluster } from "./postgres";
import { mustRun } from "./processes";

export type BackupManifest = {
  format: 1;
  createdAt: string;
  reason: string;
  automatic: boolean;
  appVersion?: string;
  schemaVersion?: string;
  services?: Record<string, string>;
  postgres: string;
  files: { database: string; storage: string; config: string };
};

export const AUTOMATIC_BACKUPS_KEPT = 5;

const folderName = (reason: string) =>
  `${new Date().toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-")}-${reason.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "backup"}`;

export async function writeBackup(options: { backups: string; storage: string; config: Config; configFile: string; cluster: Cluster; reason: string; automatic: boolean; postgresVersion: string }) {
  const { backups, cluster, reason } = options;
  await fs.mkdir(backups, { recursive: true });
  let folder = path.join(backups, folderName(reason));
  for (let n = 2; existsSync(folder); n++) folder = path.join(backups, `${folderName(reason)}-${n}`);
  const partial = `${folder}.partial`;
  await fs.mkdir(partial, { recursive: true });
  try {
    await mustRun(pgProgram(cluster, "pg_dump"), ["-h", "127.0.0.1", "-p", String(cluster.port), "-U", "supabase_admin", "-d", "postgres",
      "-Fc", "-f", path.join(partial, "database.dump")], { env: { ...process.env, PGPASSWORD: cluster.password }, timeoutMs: 30 * 60_000 });
    if (existsSync(options.storage)) await fs.cp(options.storage, path.join(partial, "storage"), { recursive: true });
    else await fs.mkdir(path.join(partial, "storage"));
    await fs.copyFile(options.configFile, path.join(partial, "config.json"));
    await fs.chmod(path.join(partial, "config.json"), 0o600);
    const manifest: BackupManifest = {
      format: 1, createdAt: new Date().toISOString(), reason, automatic: options.automatic,
      appVersion: options.config.appVersion, schemaVersion: options.config.schemaVersion, services: options.config.services,
      postgres: options.postgresVersion, files: { database: "database.dump", storage: "storage", config: "config.json" },
    };
    await fs.writeFile(path.join(partial, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.rename(partial, folder);
  } catch (error) {
    await fs.rm(partial, { recursive: true, force: true });
    throw error;
  }
  if (options.automatic) await pruneAutomatic(backups, AUTOMATIC_BACKUPS_KEPT);
  return folder;
}

// Keeps the newest `keep` automatic backups; backups the owner made are never removed.
async function pruneAutomatic(backups: string, keep: number) {
  const automatic: string[] = [];
  for (const entry of (await fs.readdir(backups)).sort().reverse()) {
    const manifest = await readManifest(path.join(backups, entry)).catch(() => undefined);
    if (manifest?.automatic) automatic.push(entry);
  }
  for (const entry of automatic.slice(keep)) await fs.rm(path.join(backups, entry), { recursive: true, force: true });
}

export async function readManifest(folder: string): Promise<BackupManifest> {
  const manifest = JSON.parse(await fs.readFile(path.join(folder, "manifest.json"), "utf8")) as BackupManifest;
  if (manifest.format !== 1) throw new Error(`${folder} is not a Moneo Desktop backup`);
  for (const file of [manifest.files.database, manifest.files.config])
    if (!existsSync(path.join(folder, file))) throw new Error(`${folder} is incomplete: ${file} is missing`);
  return manifest;
}

export async function restoreDump(cluster: Cluster, dump: string) {
  // One transaction: a failed restore leaves the fresh cluster empty instead of half-filled.
  await mustRun(pgProgram(cluster, "pg_restore"), ["-h", "127.0.0.1", "-p", String(cluster.port), "-U", "supabase_admin", "-d", "postgres",
    "--exit-on-error", "--single-transaction", dump], { env: { ...process.env, PGPASSWORD: cluster.password }, timeoutMs: 60 * 60_000 });
}
