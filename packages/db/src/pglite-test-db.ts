import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * Test-only helper: apply the real shipped `drizzle/*.sql` migrations to an
 * isolated in-memory PGlite (real PostgreSQL semantics: FKs, unique, checks,
 * RLS, roles) so tests exercise the exact SQL that runs in staging/prod.
 *
 * `upto` selects the newest migration tag to apply. Convention: chain tests
 * run to the LATEST migration, because drizzle inserts use the current
 * schema (a test pinned to an old tag breaks as soon as a later migration
 * ALTERs a table it touches). The `upto` escape hatch stays for tests that
 * must prove a historical prefix in isolation.
 */
export async function createMigratedDb(upto?: string): Promise<PGlite> {
  const db = new PGlite();
  const dir = new URL("../drizzle", import.meta.url);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error("No migration SQL files found under drizzle/");
  }
  const target = upto ?? files.at(-1)!.replace(/\.sql$/, "");
  for (const file of files) {
    const tag = file.replace(/\.sql$/, "");
    if (tag.localeCompare(target) > 0) {
      break;
    }
    const sql = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    // The drizzle migrator splits on this marker; PGlite needs the same split.
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const statement of statements) {
      await db.exec(statement);
    }
  }
  return db;
}

/** Tables that must exist after the migration chain under test. */
export async function tableNames(db: PGlite): Promise<string[]> {
  const result = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  return result.rows.map((r) => r.table_name);
}

/** First row or throw. Keeps tests free of `possibly undefined` noise. */
export function one<T>(rows: readonly T[], what = "row"): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Expected exactly one ${what}, got none`);
  }
  return row;
}

/**
 * drizzle wraps PostgreSQL errors (`Failed query: …` with the PG message in
 * `cause`). Assert against the whole chain so tests stay precise about *which*
 * constraint rejected the write (unique vs foreign key vs check vs RLS).
 */
export async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (raw: unknown) {
    const error = raw instanceof Error ? raw : new Error(`non-error thrown: ${typeof raw}`);
    const cause: unknown = error.cause;
    const causeText =
      cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "no cause";
    const chain = `${error.message} :: ${causeText}`;
    if (!pattern.test(chain)) {
      throw new Error(`Expected DB error matching ${pattern}, got: ${chain}`);
    }
    return;
  }
  throw new Error(`Expected DB error matching ${pattern}, but the write succeeded`);
}
