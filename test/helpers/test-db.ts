// Shared disposable-database helper for real-PG suites. Mirrors the E00
// proof convention: process env first, repo .env fallback. Values are never
// logged; failures name only the missing variable. Databases are disposable
// and suite-owned (refuses shared/system names); runtime I/O always uses the
// least-privilege app URL, creation uses the migration URL.

import { readFileSync } from "node:fs";
import { Pool, types } from "pg";
import { createPool, migrate, withDatabase } from "../../apps/web/src/db.ts";

// Parse DATE (OID 1082) as string in YYYY-MM-DD format to avoid timezone issues
types.setTypeParser(1082, (val: string) => val);

export function env(story: string, name: string): string {
  let value = process.env[name];
  if (!value) {
    try {
      for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m?.[1] === name) {
          value = m[2].replace(/^['"]|['"]$/g, "");
          break;
        }
      }
    } catch { /* no .env file */ }
  }
  if (!value) throw new Error(`${story} prerequisite missing: ${name} (local disposable PostgreSQL).`);
  return value;
}

export function migrationUrl(story: string, appUrl: string): string {
  const direct = process.env["DATABASE_MIGRATION_URL"];
  if (direct) return direct;
  try {
    return env(story, "DATABASE_MIGRATION_URL");
  } catch {
    return appUrl;
  }
}

/** Ensure the disposable database exists (via the migration role) and return an app-role pool, migrated. */
export async function ensureTestPool(story: string, dbName: string, truncate: string[] = []): Promise<Pool> {
  const appUrl = env(story, "DATABASE_URL");
  const setupUrl = migrationUrl(story, appUrl);
  const appDb = new URL(appUrl).pathname.replace("/", "");
  if (dbName === appDb || ["postgres", "template0", "template1"].includes(dbName) || !/^[a-z_][a-z0-9_]{0,40}$/.test(dbName)) {
    throw new Error(`${story} refused: test database must be a dedicated disposable name.`);
  }
  const setup = new Pool({ connectionString: setupUrl, connectionTimeoutMillis: 8000 });
  try {
    const found = await setup.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (found.rowCount === 0) {
      const appUser = decodeURIComponent(new URL(appUrl).username);
      if (!/^[A-Za-z_][A-Za-z0-9_@$]*$/.test(appUser)) throw new Error(`${story} refused: app-role username is not a safe SQL identifier.`);
      await setup.query(`CREATE DATABASE "${dbName}" OWNER "${appUser}"`);
    }
  } finally {
    await setup.end();
  }
  const pool = createPool(withDatabase(appUrl, dbName));
  await migrate(pool, "apps/web/migrations");
  // One statement: TRUNCATE refuses single tables that participate in FKs.
  const targets = truncate.filter((table) => /^[a-z_]+$/.test(table));
  if (targets.length !== truncate.length) throw new Error(`${story} refused: unsafe truncate target.`);
  if (targets.length > 0) await pool.query(`TRUNCATE ${targets.join(", ")}`);
  return pool;
}
