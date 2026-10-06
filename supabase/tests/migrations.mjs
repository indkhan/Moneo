// Fresh and upgraded application-schema verification; every write is rolled back.
// Supabase-owned auth/storage setup is excluded from the fresh replay.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import postgres from "postgres";
import { replayMigrations } from "./migration-replay.mjs";

process.loadEnvFile(".env");
if (!process.env.SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL is required");
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const connection = new URL(process.env.SUPABASE_DB_URL);
assert(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`),
  "Database connection must match the configured Supabase project");
const db = postgres(connection.toString(), { ssl: "require", max: 1, connect_timeout: 10, onnotice: () => {} });
const files = readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort();
const migrations = files.map(file => ({ file, version: file.split("_")[0], sql: readFileSync(`supabase/migrations/${file}`, "utf8") }));
const regressionFiles = readdirSync("supabase/tests").filter(file => file.endsWith(".sql")).sort();
const functionNames = [...new Set(migrations.flatMap(migration => [
  ...migration.sql.matchAll(/create (?:or replace )?function public\.(\w+)/g),
  ...migration.sql.matchAll(/alter function public\.\w+\([^;]*\) rename to (\w+)/g),
].map(match => match[1])))];
const schema = `moneo_migration_qa_${Date.now()}`;
const rollback = new Error("Successful rollback-only verification");

async function metadata(tx, name) {
  return {
    columns: await tx`select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema=${name} order by table_name,ordinal_position`,
    constraints: await tx`select cl.relname table_name,c.conname,c.contype,c.confdeltype,pg_get_constraintdef(c.oid) definition from pg_constraint c join pg_class cl on cl.oid=c.conrelid join pg_namespace n on n.oid=cl.relnamespace where n.nspname=${name} order by cl.relname,c.conname`,
    indexes: await tx`select tablename,indexname,indexdef from pg_indexes where schemaname=${name} order by tablename,indexname`,
    policies: await tx`select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname=${name} order by tablename,policyname`,
    rls: await tx`select c.relname table_name,c.relrowsecurity enabled from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=${name} and c.relkind='r' order by c.relname`,
    views: await tx`select c.relname name,c.reloptions options,pg_get_viewdef(c.oid) definition from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=${name} and c.relkind='v' order by c.relname`,
    triggers: await tx`select c.relname table_name,t.tgname name,t.tgenabled enabled,pg_get_triggerdef(t.oid) definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname=${name} and not t.tgisinternal order by c.relname,t.tgname`,
    functions: await tx`select p.proname name,pg_get_function_identity_arguments(p.oid) arguments,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=${name} and p.proname = any(${functionNames}) order by p.proname,arguments`,
  };
}

function normalize(rows) {
  return rows.filter(row => row.table_name !== "auth_users" && row.tablename !== "auth_users")
    .map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      typeof value === "string" ? value.replaceAll(`${schema}.auth_users`, "auth.users")
        .replaceAll(`${schema}.`, "").replaceAll("public.", "") : value])));
}

async function rolledBack(work) {
  try { await db.begin(async tx => { await work(tx); throw rollback; }); }
  catch (error) { if (error !== rollback) throw error; }
}

try {
  const applied = await db`select version from supabase_migrations.schema_migrations order by version`;
  const pending = migrations.filter(migration => !applied.some(row => row.version === migration.version));
  let fresh, upgraded;
  await rolledBack(async tx => {
    await tx.unsafe(`create schema ${schema}; create table ${schema}.auth_users (id uuid primary key, email text)`);
    // Supabase supplies schema USAGE; grant it only on the disposable replay schema.
    await tx.unsafe(`grant usage on schema ${schema} to authenticated, service_role`);
    const isolated = sql => sql.replace(/\bpublic\./g, `${schema}.`).replace(/\bauth\.users\b/g, `${schema}.auth_users`);
    const isolatedMigrations = migrations.map(migration => {
      let text = migration.sql;
      if (migration.file.endsWith("_initial.sql")) text = text.slice(0, text.indexOf("insert into storage.buckets"));
      return { ...migration, sql: isolated(text) };
    });
    await replayMigrations(tx, isolatedMigrations, "fresh");
    for (const file of regressionFiles) await tx.unsafe(isolated(readFileSync(`supabase/tests/${file}`, "utf8")));
    fresh = await metadata(tx, schema);
  });
  assert.equal((await db`select 1 from pg_namespace where nspname=${schema}`).length, 0, "QA schema must be rolled back");
  console.log(`PASS: fresh replay ${migrations.length} migrations and ${regressionFiles.length} SQL regressions; disposable schema rollback verified`);
  await rolledBack(async tx => {
    await replayMigrations(tx, pending, "upgrade");
    for (const file of regressionFiles) await tx.unsafe(readFileSync(`supabase/tests/${file}`, "utf8"));
    upgraded = await metadata(tx, "public");
  });
  for (const key of Object.keys(fresh)) assert.deepEqual(normalize(fresh[key]), normalize(upgraded[key]), `${key}: fresh and upgraded schema differ`);
  assert.deepEqual(await db`select version from supabase_migrations.schema_migrations order by version`, applied,
    "Rollback-only verification must not change migration history");
  console.log(`PASS: ${migrations.length} migrations, ${pending.length} pending upgrades, ${regressionFiles.length} SQL regressions; columns/constraints/indexes/RLS/policies/views/triggers/functions match; rollback verified`);
} finally { await db.end(); }
