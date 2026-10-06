// Authenticated RPCs in an isolated schema; no permanent public SQL or data changes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { replayMigrations } from "./migration-replay.mjs";
process.loadEnvFile(".env");
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const connection = new URL(process.env.SUPABASE_DB_URL);
assert(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`), "Configured project mismatch");
const db = postgres(connection.toString(), { ssl: "require", max: 4, connect_timeout: 10, onnotice: () => {} });
const schema = `moneo_version_qa_${randomUUID().replaceAll("-", "")}`;
assert(/^moneo_version_qa_[a-f0-9]{32}$/.test(schema));
const isolated = sql => sql.replace(/\bpublic\./g, `${schema}.`).replace(/\bauth\.users\b/g, `${schema}.auth_users`);
const actor = randomUUID(), foreign = randomUUID(), baseline = process.argv.includes("--baseline");
const manifest = { kind: "custom_comparison", runtime: "quickjs-calculator-v1", sdk: [], params: {}, renderer: "trusted" };
const recovery = `.qa/${schema}.json`;
const rollback = new Error("ROLLBACK_OK");
let created = false, release, artifact, initial;
const authenticate = async (tx, user = actor) => {
  await tx.unsafe("set local lock_timeout='8s'; set local statement_timeout='12s'");
  await tx`select set_config('request.jwt.claim.sub',${user},true)`;
  await tx.unsafe("set local role authenticated");
};
const save = (tx, base, label = "Synthetic", status = "validated", target = artifact) => tx.unsafe(
  `select * from ${schema}.save_generated_artifact_version($1,$2,$3::jsonb,$4,$5${baseline ? "" : ",$6"})`,
  [target, `(input) => ({summary:"${label}"})`, tx.json(manifest), status, status === "failed" ? "Synthetic failure" : "", ...(!baseline ? [base] : [])]);
try {
  const ledger = await db`select version from supabase_migrations.schema_migrations order by version`;
  const publicAcl = await db`select nspacl::text from pg_namespace where nspname='public'`;
  writeFileSync(recovery, JSON.stringify({ schema, project }));
  await db.begin(async tx => {
    await tx.unsafe(`create schema ${schema}; create table ${schema}.auth_users(id uuid primary key,email text); grant usage on schema ${schema} to authenticated,service_role`);
    const migrations = readdirSync("supabase/migrations").filter(file => file.endsWith(".sql") && !(baseline && file.startsWith("202610060006"))).sort().map(file => {
      let sql = readFileSync(`supabase/migrations/${file}`, "utf8");
      if (file.endsWith("_initial.sql")) sql = sql.slice(0, sql.indexOf("insert into storage.buckets"));
      return { file, sql: isolated(sql) };
    });
    await replayMigrations(tx, migrations, "isolated-artifact");
    await tx`insert into ${tx(`${schema}.auth_users`)}(id,email) values(${actor},${`qa-${actor}@example.invalid`}),(${foreign},${`qa-${foreign}@example.invalid`})`;
    await authenticate(tx);
    const [row] = await tx.unsafe(`select * from ${schema}.create_trusted_artifact('custom_comparison','Synthetic version CAS')`);
    artifact = row.id; initial = row.active_version_id;
  });
  created = true;
  // Stale draft/restore/direct edit all use the same activation transaction.
  try { await db.begin(async tx => {
    await authenticate(tx);
    const [first] = await save(tx, initial, "First");
    if (baseline) {
      const [stale] = await save(tx, initial, "Stale");
      assert.equal(stale.version, 3);
      console.log("BASELINE: authenticated stale activation silently replaces the newer version");
    } else {
      const stale = await tx.savepoint(async point => save(point, initial, "Stale")).then(() => "success", error => error.code);
      assert.equal(stale, "40001");
      const unknownBase = await tx.savepoint(point => save(point, null, "Unknown base")).then(() => "success", error => error.code);
      assert.equal(unknownBase, "40001", "Unknown legacy draft base cannot bypass CAS");
      const [active] = await tx.unsafe(`select active_version_id from ${schema}.artifacts where id=$1`, [artifact]);
      assert.equal(active.active_version_id, first.id);
      assert.equal((await tx.unsafe(`select count(*)::int n from ${schema}.artifact_versions where artifact_id=$1`, [artifact]))[0].n, 2);
      await save(tx, initial, "Failed", "failed");
      assert.equal((await tx.unsafe(`select active_version_id from ${schema}.artifacts where id=$1`, [artifact]))[0].active_version_id, first.id);
      const oldSave = await tx.savepoint(point => point.unsafe(`select ${schema}.save_generated_artifact_version($1,$2,$3::jsonb,'validated','')`, [artifact, "input => ({})", point.json(manifest)])).then(() => "success", error => error.code);
      const oldRename = await tx.savepoint(point => point.unsafe(`select ${schema}.rename_trusted_artifact($1,'Old bypass')`, [artifact])).then(() => "success", error => error.code);
      assert.equal(oldSave, "42501"); assert.equal(oldRename, "42501");
      const staleRename = await tx.savepoint(point => point.unsafe(`select ${schema}.rename_trusted_artifact($1,'Stale rename',$2)`, [artifact, initial])).then(() => "success", error => error.code);
      assert.equal(staleRename, "40001");
      await tx.unsafe(`select ${schema}.rename_trusted_artifact($1,'Current rename',$2)`, [artifact, first.id]);
      console.log("PASS authenticated stale saves/renames rejected atomically; failed attempts retained; old RPC CAS bypass denied");
      let latest = (await tx.unsafe(`select active_version_id from ${schema}.artifacts where id=$1`, [artifact]))[0].active_version_id;
      for (let i = 0; i < 21; i++) [ { id: latest } ] = await save(tx, latest, `History ${i}`);
      const older = await tx.unsafe(`select id,version,source,manifest from ${schema}.artifact_versions where artifact_id=$1 and version<6 order by version desc`, [artifact]);
      assert(older.some(row => row.id === first.id), "First calculator is reachable past 20 newer versions");
      const beforeState = await tx.unsafe(`select state,version from ${schema}.artifact_state where artifact_id=$1`, [artifact]);
      const [restored] = await tx.unsafe(`select * from ${schema}.save_generated_artifact_version($1,$2,$3::jsonb,'validated','',$4)`, [artifact, first.source, tx.json(first.manifest), latest]);
      assert.equal(restored.version, 26); assert.notEqual(restored.id, first.id); assert.equal(restored.source, first.source);
      assert.deepEqual(await tx.unsafe(`select id,version,source,manifest from ${schema}.artifact_versions where artifact_id=$1 and version<6 order by version desc`, [artifact]), older, "Stable keyset excludes newly inserted revisions");
      assert.deepEqual(await tx.unsafe(`select state,version from ${schema}.artifact_state where artifact_id=$1`, [artifact]), beforeState, "Restore preserves saved state");
      console.log("PASS actual SQL history beyond 21 versions, stable keyset, restore creates version 26 and preserves source history/state");
    }
    throw rollback;
  }); } catch (error) { if (error !== rollback) throw error; }
  assert.equal((await db.unsafe(`select count(*)::int n from ${schema}.artifact_versions where artifact_id=$1`, [artifact]))[0].n, 1, "Rollback fixture must leave original version only");
  if (!baseline) {
    const denied = await db.begin(async tx => { await authenticate(tx, foreign); await save(tx, initial); }).then(() => "success", error => error.code);
    assert.equal(denied, "P0002");
    // First transaction activates but holds its row lock; a stale second connection must wait and recheck.
    let ready, pid;
    const locked = new Promise(resolve => { ready = resolve; });
    const unlock = new Promise(resolve => { release = resolve; });
    const holder = db.begin(async tx => { await authenticate(tx); await save(tx, initial, "Winner"); ready(); await unlock; });
    holder.catch(error => ready(error));
    const error = await locked; if (error) throw error;
    const waiter = db.begin(async tx => { await authenticate(tx); [{pid}] = await tx`select pg_backend_pid() pid`; await save(tx, initial, "Loser"); }).then(() => "success", error => error.code);
    try {
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        if (pid) blocked = (await db`select 1 from pg_stat_activity where pid=${pid} and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0`).length > 0;
        if (!blocked) await delay(20);
      }
      assert(blocked, "Second authenticated activation must wait on the existing artifact lock");
    } finally { release(); }
    await holder; assert.equal(await waiter, "40001");
    assert.equal((await db.unsafe(`select count(*)::int n from ${schema}.artifact_versions where artifact_id=$1`, [artifact]))[0].n, 2);
    console.log("PASS actual concurrent authenticated RPCs: waiter blocks, then rejects unseen winner; no losing version inserted");
  }
  assert.deepEqual(await db`select version from supabase_migrations.schema_migrations order by version`, ledger);
  assert.deepEqual(await db`select nspacl::text from pg_namespace where nspname='public'`, publicAcl);
} finally {
  release?.();
  if (created) await db.unsafe(`drop schema ${schema} cascade`);
  assert.equal((await db`select 1 from pg_namespace where nspname=${schema}`).length, 0, "Disposable schema cleanup verified");
  try { unlinkSync(recovery); } catch {}
  await db.end();
  console.log("Disposable schema removed; public ledger/privileges unchanged");
}
