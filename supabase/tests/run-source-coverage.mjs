// Fresh schema and synthetic source-publication fixtures; one transaction always rolls back.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import postgres from "postgres";
import { replayMigrations } from "./migration-replay.mjs";
import { sourceCoverageReaderProof } from "./source-coverage-reader.mjs";
if (existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL required for disposable-schema SQL acceptance");
const db = postgres(process.env.SUPABASE_DB_URL, { ssl: "require", max: 1, connect_timeout: 10, onnotice: () => {} });
const schema = `mne008_${randomUUID().replaceAll("-", "")}`;
const rollback = new Error("successful rollback");
const isolated = sql => sql.replace(/\bpublic\./g, `${schema}.`).replace(/\bschema public\b/g, `schema ${schema}`)
  .replace(/\bauth\.users\b/g, `${schema}.auth_users`).replace(/create extension if not exists pgcrypto;/gi, "");
try {
  const applied = await db`select version from supabase_migrations.schema_migrations order by version`;
  assert.equal((await db`select 1 from pg_extension where extname='pgcrypto'`).length, 1);
  try { await db.begin(async tx => {
    await tx.unsafe(`create schema ${schema}; create table ${schema}.auth_users(id uuid primary key,email text); grant usage on schema ${schema} to authenticated,service_role`);
    const files = readdirSync("supabase/migrations").filter(file => file.endsWith(".sql") &&
      !(process.argv.includes("--baseline") && file.startsWith("202610060011"))).sort();
    await replayMigrations(tx, files.map(file => {
      let sql = readFileSync(`supabase/migrations/${file}`, "utf8");
      if (file.endsWith("_initial.sql")) sql = sql.slice(0, sql.indexOf("insert into storage.buckets"));
      return { file, sql: isolated(sql) };
    }), "MNE008 disposable replay");
    for (const file of ["source-coverage.sql", "atomic-review.sql", "import-review.sql", "import-row-exclusions.sql"]) {
      await tx.unsafe(isolated(readFileSync(`supabase/tests/${file}`, "utf8")));
      console.log(`PASS ${file}`);
    }
    await sourceCoverageReaderProof(tx, schema);
    throw rollback;
  }); } catch (error) { if (error !== rollback) throw error; }
  assert.equal((await db`select 1 from pg_namespace where nspname=${schema}`).length, 0);
  assert.deepEqual(await db`select version from supabase_migrations.schema_migrations order by version`, applied);
  console.log("PASS disposable schema rollback and unchanged applied migration history; no public SQL writes");
} finally { await db.end(); }
