// MNE014 disposable-schema cadence regression. Requires explicit shared-slot release.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {existsSync, readFileSync, readdirSync, mkdirSync, appendFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";
import postgres from "postgres";
import {checkSerialization} from "./coverage-recurring-serialization.mjs";
import {replayMigrations} from "./migration-replay.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
assert.equal(path.resolve(process.cwd()).toLowerCase(), path.resolve(root).toLowerCase(), "Run from the MNE014 worktree");
const baseline = process.argv.includes("--baseline");
const upgrade = process.argv.includes("--upgrade");
const serialize = process.argv.includes("--serialize");
assert(Number(baseline)+Number(upgrade)+Number(serialize)<=1, "Choose one SQL gate mode");
const candidate = "202610070017_coverage_recurring.sql";
const git = spawnSync("git", ["rev-parse", "HEAD"], {cwd: root, encoding: "utf8"});
assert.equal(git.status, 0);
const head = git.stdout.trim();
if (existsSync(".env")) process.loadEnvFile(".env");
assert(process.env.SUPABASE_DB_URL && process.env.NEXT_PUBLIC_SUPABASE_URL, "Configured synthetic SQL prerequisites required");
const connection = new URL(process.env.SUPABASE_DB_URL);
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
assert(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`), "Project/database mismatch");
const schema = `mne014_${randomUUID().replaceAll("-", "")}`;
const run = {task: "MNE014", schema, worktree: root, head, marker: randomUUID(), mode: baseline ? "baseline" : upgrade ? "upgrade" : serialize ? "serialization" : "fresh"};
mkdirSync(".qa", {recursive: true});
const journal = `.qa/${schema}-owner.jsonl`;
const record = value => appendFileSync(journal, JSON.stringify({...run, at: new Date().toISOString(), ...value}) + "\n");
record({phase: "prepared", rollbackOnly: !serialize, ownerRecordsRead: false, publicDdl: false});
const db = postgres(connection.toString(), {ssl: "require", max: 1, connect_timeout: 10, connection: {application_name: `MNE014-${run.marker}`, statement_timeout: "20000", lock_timeout: "3000", idle_in_transaction_session_timeout: "30000"}, onnotice: () => {}});
const rollback = new Error("MNE014 verified rollback");
function isolated(sql) {
  const rewritten = sql.replace(/\bpublic\./g, `${schema}.`).replace(/\bschema public\b/g, `schema ${schema}`)
    .replace(/\bauth\.users\b/g, `${schema}.auth_users`).replace(/create extension if not exists pgcrypto;/gi, "");
  assert(!/\b(public\.|auth\.users\b|storage\.(objects|buckets))/i.test(rewritten), "Unisolated SQL target rejected");
  return rewritten;
}
let failure;
try {
  const history = await db`select version from supabase_migrations.schema_migrations order by version`;
  assert.equal((await db`select 1 from pg_extension where extname='pgcrypto'`).length, 1);
  const files = readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort();
  if (!baseline) assert(files.includes(candidate), "Author reserved migration after baseline RED before green acceptance");
  try { await db.begin(async tx => {
    await tx`select set_config('application_name', ${`MNE014-${run.marker}`}, true), set_config('statement_timeout', '20000', true), set_config('lock_timeout', '3000', true), set_config('idle_in_transaction_session_timeout', '30000', true)`;
    await tx.unsafe(`create schema ${schema}; create table ${schema}.qa_owner(metadata jsonb not null); create table ${schema}.auth_users(id uuid primary key,email text); grant usage on schema ${schema} to authenticated,service_role`);
    await tx.unsafe(`insert into ${schema}.qa_owner(metadata) values($1::jsonb)`, [tx.json(run)]);
    const [ownership] = await tx.unsafe(`select metadata, current_user as actor, (select nspowner::regrole::text from pg_namespace where nspname=$1) as schema_owner from ${schema}.qa_owner`, [schema]);
    assert.deepEqual(ownership.metadata, run, "Private schema metadata/marker mismatch");
    assert.equal(ownership.actor, ownership.schema_owner, "Private schema owner mismatch");
    const prepared = JSON.parse(readFileSync(journal, "utf8").trim().split("\n")[0]);
    for (const key of ["task", "schema", "worktree", "head", "marker", "mode"]) assert.equal(prepared[key], run[key], `Journal ownership mismatch: ${key}`);
    record({phase: "ownership_verified", schemaOwner: ownership.schema_owner, markerVerified: true});
    const replay = files.filter(file => !(file === candidate && (baseline || upgrade))).map(file => {
      let sql = readFileSync(`supabase/migrations/${file}`, "utf8");
      if (file.endsWith("_initial.sql")) sql = sql.slice(0, sql.indexOf("insert into storage.buckets"));
      return {file, sql: isolated(sql)};
    });
    await replayMigrations(tx, replay, "MNE014 private replay");
    if (upgrade) {
      // Seed and exercise old-schema histories first; then apply only reserved 017 privately.
      await tx.unsafe(isolated(readFileSync("supabase/tests/planning-history.sql", "utf8")));
      await tx.unsafe(isolated(readFileSync("supabase/tests/coverage-recurring-upgrade-seed.sql", "utf8")));
      await replayMigrations(tx, [{file: candidate, sql: isolated(readFileSync(`supabase/migrations/${candidate}`, "utf8"))}], "MNE014 private upgrade");
    }
    if (upgrade) await tx.unsafe(isolated(readFileSync("supabase/tests/coverage-recurring-upgrade-undo.sql", "utf8")));
    record({phase: "replayed"});
    await tx.unsafe(isolated(readFileSync("supabase/tests/coverage-recurring.sql", "utf8")));
    for (const fixture of ["planning-history.sql", "verified-links.sql", "recurring-occurrences.sql"]) {
      await tx`select set_config('request.jwt.claim.sub', '', true)`;
      await tx.unsafe(isolated(readFileSync(`supabase/tests/${fixture}`, "utf8")));
      record({phase: "regression", fixture});
    }
    if (!serialize) throw rollback;
  }); } catch (error) { if (error !== rollback) failure = error; }
  if (serialize) {
    try { if (!failure) await checkSerialization(db,connection,schema,run,record); }
    catch (error) { failure=error; }
    const exists=(await db`select 1 from pg_namespace where nspname=${schema}`).length;
    const owned = exists ? await db.unsafe(`select metadata, current_user as actor, (select nspowner::regrole::text from pg_namespace where nspname=$1) as schema_owner from ${schema}.qa_owner`, [schema]) : [];
    if (owned.length) {
      assert.deepEqual(owned[0].metadata,run); assert.equal(owned[0].actor,owned[0].schema_owner);
      const prepared=JSON.parse(readFileSync(journal,"utf8").trim().split("\n")[0]);
      for (const key of ["task","schema","worktree","head","marker","mode"]) assert.equal(prepared[key],run[key]);
      await db.begin(async tx=>{await tx`select set_config('lock_timeout','3000',true),set_config('statement_timeout','20000',true)`;await tx.unsafe(`drop schema ${schema} cascade`);});
    }
  }
  const remaining = (await db`select count(*)::int as count from pg_namespace where nspname=${schema}`)[0].count;
  assert.equal(remaining, 0, "Exact private schema cleanup required");
  assert.deepEqual(await db`select version from supabase_migrations.schema_migrations order by version`, history, "Public migration ledger changed");
  record({phase: "cleanup", remainingSchemas: remaining, publicMigrationLedgerUnchanged: true, publicRecordReads: 0});
  if (failure) throw failure;
  console.log(`PASS MNE014 ${run.mode}: cadence/owned-source/settlement/history checks; exact private schema cleanup=0; public migration ledger unchanged`);
} catch (error) {
  record({phase: "failed", sqlstate: error.code ?? error.cause?.code ?? null, message: error.message});
  throw error;
} finally { await db.end({timeout: 5}); record({phase: "sql_closed"}); }
