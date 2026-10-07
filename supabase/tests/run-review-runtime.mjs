// Schema replay/races use an exactly removed disposable schema; regression fixtures roll back.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import postgres from "postgres";
import { replayMigrations } from "./migration-replay.mjs";
import { reviewRuntimeRaces } from "./review-runtime-races.mjs";
if (existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL required for disposable-schema SQL acceptance");
const db = postgres(process.env.SUPABASE_DB_URL, {ssl: "require", max: 3, connect_timeout: 10, onnotice: () => {}});
const schema = `mne020_${randomUUID().replaceAll("-", "")}`;
const rollback = new Error("ROLLBACK_OK");
const isolated = sql => sql.replace(/\bpublic\./g, `${schema}.`).replace(/\bschema public\b/g, `schema ${schema}`)
  .replace(/\bauth\.users\b/g, `${schema}.auth_users`).replace(/create extension if not exists pgcrypto;/gi, "");
try {
  assert.equal((await db`select 1 from pg_extension where extname='pgcrypto'`).length, 1, "Existing Supabase pgcrypto is required; this harness never installs extensions");
  try {
    await db.begin(async tx => {
      await tx.unsafe(`create schema ${schema}; create table ${schema}.auth_users(id uuid primary key,email text); grant usage on schema ${schema} to authenticated,service_role`);
      const migrations = readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort().map(file => {
        let sql = readFileSync(`supabase/migrations/${file}`, "utf8");
        if (file.endsWith("_initial.sql")) sql = sql.slice(0, sql.indexOf("insert into storage.buckets"));
        return { file, sql: isolated(sql) };
      });
      await replayMigrations(tx, migrations, "MNE020 disposable replay");
    });
    await db.begin(async tx => {
      for (const file of ["review-start.sql", "atomic-review.sql", "review-runtime.sql", "review-recovery.sql"]) await tx.unsafe(isolated(readFileSync(`supabase/tests/${file}`, "utf8")));
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  console.log("PASS: disposable schema replay, review request identity, run election/receipts, privilege/workspace checks, terminal replay and cancel/publication acceptance");
  await reviewRuntimeRaces(db, schema);
} finally {
  // Exact generated schema only. Public application/auth/storage data is never written.
  assert.match(schema, /^mne020_[a-f0-9]{32}$/);
  try {
    await db.unsafe(`drop schema if exists ${schema} cascade`);
    assert.equal((await db`select 1 from pg_namespace where nspname=${schema}`).length, 0, "Disposable schema cleanup must be exact");
  } finally { await db.end(); }
}
console.log("PASS: regression transaction rollback and exact disposable schema cleanup verified; no public SQL writes");
