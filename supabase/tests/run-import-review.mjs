// Synthetic authenticated acceptance in a disposable application schema; always rolled back.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import postgres from "postgres";
import { applicationMigrationSql, replayMigrations } from "./migration-replay.mjs";
process.loadEnvFile(".env.qa");
const connection = new URL(process.env.SUPABASE_DB_URL);
const db = postgres(connection.toString(), { max: 1, onnotice: () => {} });
const schema = `mne007_qa_${Date.now()}`;
const rollback = new Error("successful rollback");
try {
  const applied = await db`select version from supabase_migrations.schema_migrations order by version`;
  console.log(`Applied migration count: ${applied.length}; candidate applied: ${applied.some(row => row.version === "202610060007")}`);
  try { await db.begin(async tx => {
    await tx.unsafe(`create schema ${schema}; create table ${schema}.auth_users(id uuid primary key,email text); grant usage on schema ${schema} to authenticated,service_role`);
    const isolated = sql => sql.replace(/\bpublic\./g, `${schema}.`).replace(/\bauth\.users\b/g, `${schema}.auth_users`);
    const files = readdirSync("supabase/migrations").filter(file => file.endsWith(".sql") && (!process.argv.includes("--baseline") || !file.startsWith("202610060007"))).sort();
    await replayMigrations(tx, files.map(file => {
      let sql = readFileSync(`supabase/migrations/${file}`, "utf8");
      sql = applicationMigrationSql(file, sql, schema);
      return { file, sql: isolated(sql) };
    }), "fresh MNE007");
    const tests = process.argv.includes("--baseline") ? [process.argv.includes("--parity") ? "import-review-parity-baseline.sql" : "import-review-baseline.sql"] : ["import-review.sql", "import-row-exclusions.sql", "workspace-isolation.sql", "import-control.sql", "import-reimport.sql"];
    for (const file of tests) {
      const path = file.endsWith("baseline.sql") ? ".qa" : "supabase/tests";
      await tx.unsafe(isolated(readFileSync(`${path}/${file}`, "utf8")));
      console.log(`PASS ${file}`);
    }
    throw rollback;
  }); } catch (error) { if (error !== rollback) throw error; }
  assert.equal((await db`select 1 from pg_namespace where nspname=${schema}`).length, 0);
  assert.deepEqual(await db`select version from supabase_migrations.schema_migrations order by version`, applied);
  console.log("PASS exact disposable schema rollback and unchanged applied migration history");
} finally { await db.end(); }
