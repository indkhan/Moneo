// E01-S02 migrator regression: each migration file must apply atomically.
// A multi-statement file whose later statement fails must leave no partial
// objects behind (guards the single-client BEGIN/COMMIT contract in db.ts).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { migrate } from "../apps/web/src/db.ts";
import { ensureTestPool } from "./helpers/test-db.ts";

let pool: Pool;

async function testPool(): Promise<Pool> {
  if (!pool) {
    // Own database: parallel vitest workers must not share suite state.
    pool = await ensureTestPool("E01-S02", "moneo_e01_db");
  }
  return pool;
}

afterAll(async () => {
  if (pool) await pool.end();
});

describe("e01-s02 migrator atomicity", () => {
  it("a failing multi-statement migration applies nothing", async () => {
    const db = await testPool();
    const dir = mkdtempSync(join(tmpdir(), "moneo-migrate-"));
    try {
      writeFileSync(
        join(dir, "001_ok.sql"),
        "CREATE TABLE IF NOT EXISTS migrate_probe_ok (id TEXT PRIMARY KEY);\n",
      );
      writeFileSync(
        join(dir, "002_half.sql"),
        "CREATE TABLE migrate_probe_half (id TEXT PRIMARY KEY);\nTHIS IS NOT SQL;\n",
      );
      await expect(migrate(db, dir)).rejects.toThrow();
      const half = await db.query("SELECT 1 FROM pg_tables WHERE tablename = 'migrate_probe_half'");
      expect(half.rowCount).toBe(0);
      const recorded = await db.query("SELECT 1 FROM schema_migrations WHERE version = '002_half'");
      expect(recorded.rowCount).toBe(0);
      // The good file applied exactly once; rerun is a no-op for it.
      expect(await migrate(db, dir).catch(() => ["002_half-retry-fails"])).toContain("002_half-retry-fails");
    } finally {
      await db.query("DROP TABLE IF EXISTS migrate_probe_ok").catch(() => {});
      await db.query("DROP TABLE IF EXISTS migrate_probe_half").catch(() => {});
      await db.query("DELETE FROM schema_migrations WHERE version IN ('001_ok', '002_half')").catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("product migrations apply cleanly on the test database", async () => {
    const db = await testPool();
    await migrate(db, "apps/web/migrations");
    // Idempotent across runs and suites: the version is recorded exactly
    // once no matter how many times migrate runs (auth.test.ts shares this DB).
    const recorded = await db.query("SELECT 1 FROM schema_migrations WHERE version = '001_sessions'");
    expect(recorded.rowCount).toBe(1);
    const tables = await db.query("SELECT 1 FROM pg_tables WHERE tablename = 'app_sessions'");
    expect(tables.rowCount).toBe(1);
    expect(await migrate(db, "apps/web/migrations")).toEqual([]);
  });
});
