// E01-S02 minimal data boundary: pg pool helper plus an ordered file
// migrator. No ORM, no query builder; product code uses parameterized
// statements only. Models never get raw SQL (there are no models yet).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 5 });
}

/** Point a postgres connection string at a different database name. */
export function withDatabase(connectionString: string, dbName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/**
 * Apply pending `*.sql` migrations (excluding `*.rollback.sql`) in filename
 * order inside one transaction per file, recording each version. Fails
 * closed on any error; safe to rerun (completed versions are skipped).
 */
export async function migrate(pool: Pool, migrationsDir: string): Promise<string[]> {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".rollback.sql"))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    // A missing schema_migrations table means no migration has ever applied;
    // any other SELECT failure is a real error and must not be swallowed.
    let done = null;
    try {
      done = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
    } catch (err) {
      if ((err as { code?: string }).code !== "42P01") throw err;
    }
    if (done && (done.rowCount ?? 0) > 0) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    // One dedicated client per file: BEGIN/body/COMMIT must share a single
    // connection, otherwise pool.query may spread them across connections and
    // a multi-statement migration could half-apply.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", [version]);
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch { /* already failed; preserve the original error */ }
      throw err;
    } finally {
      client.release();
    }
    applied.push(version);
  }
  return applied;
}
