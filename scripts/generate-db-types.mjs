import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import { applicationMigrationSql } from "../supabase/tests/migration-replay.mjs";

const SUPABASE_CLI = "supabase@2.122.1";
const OUTPUT = "lib/database.types.ts";

if (!existsSync(".env.qa")) throw new Error("No test backend: run `npm run setup -- --qa` first");
process.loadEnvFile(".env.qa");
if (!process.env.SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL is required in .env.qa");

const admin = new URL(process.env.SUPABASE_DB_URL);
const name = `moneo_types_${process.pid}_${Date.now()}`;
const disposable = new URL(admin);
disposable.pathname = `/${name}`;
disposable.searchParams.set("sslmode", "disable");
const cluster = postgres(admin.toString(), { max: 1, connect_timeout: 10, onnotice: () => {} });

const stubs = `
  create schema extensions;
  create extension pgcrypto schema extensions;
  create extension pg_trgm schema extensions;
  alter database ${name} set search_path = public, extensions;
  set search_path = public, extensions;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  create function auth.role() returns text language sql stable as $$ select null::text $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select null::jsonb $$;
  grant usage on schema auth, extensions to authenticated, service_role, anon;
`;

async function replay() {
  const db = postgres(disposable.toString(), { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    await db.unsafe(stubs);
    const files = readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort();
    for (const file of files) {
      try { await db.unsafe(applicationMigrationSql(file, readFileSync(`supabase/migrations/${file}`, "utf8"))); }
      catch (cause) { throw new Error(`Migration ${file} failed on the disposable database (SQLSTATE ${cause.code ?? "unknown"}).`, { cause }); }
    }
  } finally { await db.end(); }
}

let types;
try {
  await cluster.unsafe(`create database ${name}`);
  await replay();
  const cli = spawnSync("npx", ["--yes", SUPABASE_CLI, "gen", "types", "typescript", "--db-url", disposable.toString(), "--schema", "public"], { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
  if (cli.status !== 0) throw new Error(`supabase gen types failed (${cli.status}): ${cli.stderr}`);
  types = cli.stdout.replaceAll("\r\n", "\n");
} finally {
  await cluster.unsafe(`drop database if exists ${name} with (force)`);
  await cluster.end();
}
writeFileSync(OUTPUT, types);
console.log(`Wrote ${OUTPUT} from ${readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).length} migrations`);
