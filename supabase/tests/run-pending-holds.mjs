// Synthetic authenticated acceptance in a disposable application schema; always rolled back.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import postgres from "postgres";
import { replayMigrations } from "./migration-replay.mjs";
process.loadEnvFile(".env");
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const connection = new URL(process.env.SUPABASE_DB_URL);
assert(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`));
const db = postgres(connection.toString(), { ssl: "require", max: 1, onnotice: () => {} });
const schema = `mne006_qa_${Date.now()}`;
const rollback = new Error("successful rollback");
try {
  const applied = await db`select version from supabase_migrations.schema_migrations order by version`;
  console.log(`Applied migration count: ${applied.length}; candidate applied: ${applied.some(row => row.version === "202610060010")}`);
  try { await db.begin(async tx => {
    await tx.unsafe(`create schema ${schema}; create table ${schema}.auth_users(id uuid primary key,email text); grant usage on schema ${schema} to authenticated,service_role`);
    const isolated = sql => sql.replace(/\bpublic\./g, `${schema}.`).replace(/\bauth\.users\b/g, `${schema}.auth_users`);
    const files = readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort();
    await replayMigrations(tx, files.map(file => {
      let sql = readFileSync(`supabase/migrations/${file}`, "utf8");
      if (file.endsWith("_initial.sql")) sql = sql.slice(0, sql.indexOf("insert into storage.buckets"));
      return { file, sql: isolated(sql) };
    }), "fresh MNE006");
    const tests = ["pending-holds.sql", "import-review.sql", "import-control.sql", "import-reimport.sql", "workspace-isolation.sql"];
    for (const file of tests) {
      const path = "supabase/tests";
      await tx.unsafe(isolated(readFileSync(`${path}/${file}`, "utf8")));
      console.log(`PASS ${file}`);
    }
    throw rollback;
  }); } catch (error) { if (error !== rollback) throw error; }
  assert.equal((await db`select 1 from pg_namespace where nspname=${schema}`).length, 0);
  assert.deepEqual(await db`select version from supabase_migrations.schema_migrations order by version`, applied);
  console.log("PASS exact disposable schema rollback and unchanged applied migration history");
} finally { await db.end(); }
