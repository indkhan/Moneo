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
    const done = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]).catch(() => null);
    if (done && (done.rowCount ?? 0) > 0) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", [version]);
      await pool.query("COMMIT");
    } catch (err) {
      await pool.query("ROLLBACK");
      throw err;
    }
    applied.push(version);
  }
  return applied;
}
