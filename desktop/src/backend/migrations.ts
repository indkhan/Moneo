// Database setup: the Supabase-image bootstrap (desktop/bootstrap), Moneo's supabase/migrations
// applied exactly like scripts/setup.mjs, and the owner account.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

export type Db = ReturnType<typeof postgres>;

export function connect(port: number, user: string, password: string, database = "postgres"): Db {
  return postgres({ host: "127.0.0.1", port, user, password, database, max: 1, onnotice: () => {}, connect_timeout: 10 });
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

// Passwords and JWT settings, the values docker/db/roles.sql sets in the Docker backend.
export async function applyRoleSecrets(db: Db, password: string, jwtSecret: string) {
  for (const role of ["supabase_admin", "postgres", "authenticator", "supabase_auth_admin", "supabase_storage_admin"])
    await db.unsafe(`alter role ${role} with password ${literal(password)}`);
  await db.unsafe(`alter database postgres set "app.settings.jwt_secret" to ${literal(jwtSecret)}`);
  await db.unsafe(`alter database postgres set "app.settings.jwt_exp" to '3600'`);
}

// files: the bootstrap SQL to run (all of them on a fresh cluster; only roles before a restore).
export async function bootstrap(db: Db, folder: string, files: string[], password: string, jwtSecret: string) {
  for (const file of files) {
    const sql = readFileSync(path.join(folder, file), "utf8");
    await db.begin(tx => tx.unsafe(sql));
  }
  await applyRoleSecrets(db, password, jwtSecret);
}

export const bootstrapFiles = (folder: string) => readdirSync(folder).filter(file => file.endsWith(".sql")).sort();

export type MigrationFile = { file: string; version: string };

export function bundledMigrations(folder: string): MigrationFile[] {
  return readdirSync(folder).filter(file => file.endsWith(".sql")).sort().map(file => ({ file, version: file.split("_")[0] }));
}

// Same history table as the Supabase CLI and scripts/setup.mjs.
export async function migrationState(db: Db, bundled: MigrationFile[]) {
  await db`create schema if not exists supabase_migrations`;
  await db`create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)`;
  const applied = (await db<{ version: string }[]>`select version from supabase_migrations.schema_migrations`).map(row => row.version);
  const latest = bundled.at(-1)?.version ?? "";
  const newer = applied.filter(version => version > latest).sort();
  const known = new Set(applied);
  return { applied, newer, pending: bundled.filter(migration => !known.has(migration.version)) };
}

// supautils, which the Supabase image loads and Moneo does not bundle, lets postgres create and drop
// policies and triggers on the auth.* and storage.* tables (supautils.policy_grants /
// drop_trigger_grants). Without it the same statements need ownership, so during Moneo's own
// migrations postgres inherits the two owner roles, and loses them again right after.
const OWNERS = ["supabase_auth_admin", "supabase_storage_admin"];
export async function revokeMigrationOwners(admin: Db) {
  for (const role of OWNERS) await admin.unsafe(`revoke ${role} from postgres`);
}

export async function applyMigrations(admin: Db, owner: Db, folder: string, pending: MigrationFile[], log: (line: string) => void) {
  if (!pending.length) return 0;
  for (const role of OWNERS) await admin.unsafe(`grant ${role} to postgres with inherit true, set false`);
  try {
    for (const { file, version } of pending) {
      const source = readFileSync(path.join(folder, file), "utf8");
      await owner.begin(async tx => {
        await tx.unsafe(source);
        await tx`insert into supabase_migrations.schema_migrations (version, name, statements) values (${version}, ${file.slice(version.length + 1, -4)}, ${[source]})`;
      });
      log(`Applied migration ${file}`);
    }
  } finally {
    await revokeMigrationOwners(admin);
  }
  // PostgREST caches the schema; reload it after migrations.
  await owner`notify pgrst, 'reload schema'`;
  return pending.length;
}

export async function createOwner(apiUrl: string, serviceKey: string, email: string, password: string) {
  const response = await fetch(`${apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({})) as { error_code?: string };
  if (!response.ok && body.error_code !== "email_exists") throw new Error(`Could not create the owner account: ${response.status} ${JSON.stringify(body)}`);
  return response.ok;
}
