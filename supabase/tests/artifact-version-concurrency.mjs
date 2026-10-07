// Service-only generated saves and authenticated identity RPCs in an isolated schema; no permanent public SQL or data changes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
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
const actor = randomUUID(), foreign = randomUUID();
const manifest = { kind: "custom_comparison", runtime: "quickjs-calculator-v1", sdk: [], params: {}, renderer: "trusted" };
const recovery = `.qa/${schema}.json`;
const rollback = new Error("ROLLBACK_OK");
let created = false, release, artifact, initial;
const authenticate = async (tx, user = actor) => {
  await tx.unsafe("set local lock_timeout='8s'; set local statement_timeout='12s'");
  await tx`select set_config('request.jwt.claim.sub',${user},true)`;
  await tx.unsafe("set local role authenticated");
};
async function testRolePrivileges(tx) {
  const functions = await tx.unsafe(`select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname in ('save_generated_artifact_version','save_validated_generated_artifact_version')`, [schema]);
  for (const fn of functions) {
    for (const role of ["anon", "authenticated"]) {
      const [result] = await tx`select has_function_privilege(${role},${fn.oid},'EXECUTE') allowed`;
      assert.equal(result.allowed, false, `${role} must not execute ${fn.proname}(${fn.args})`);
    }
    const [service] = await tx`select has_function_privilege('service_role',${fn.oid},'EXECUTE') allowed`;
    assert.equal(service.allowed, fn.proname === "save_validated_generated_artifact_version");
  }
  assert.equal(functions.filter(fn => fn.proname === "save_validated_generated_artifact_version").length, 1);
  // Immutable builtin history cannot be replaced or populated by ordinary roles.
  for (const role of ["anon", "authenticated"]) {
    for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
      const [result] = await tx`select has_table_privilege(${role},${`${schema}.artifact_versions`},${privilege}) allowed`;
      assert.equal(result.allowed, false, `${role} must not ${privilege} artifact_versions`);
    }
  }
  console.log("PASS ordinary-role execution denied for every generated-save signature; immutable history writes denied; service executes only trusted save");
}
const snapshot = tx => tx.unsafe(`select (select row_to_json(a) from ${schema}.artifacts a where id=$1) artifact, (select jsonb_agg(v order by version) from ${schema}.artifact_versions v where artifact_id=$1) versions, (select row_to_json(s) from ${schema}.artifact_state s where artifact_id=$1) state`, [artifact]);
const save = async (tx, base, label = "Synthetic", status = "validated", target = artifact, verifiedActor = actor, source = `(input) => ({summary:"${label}"})`, candidateManifest = manifest) => {
  await tx`select set_config('request.jwt.claim.sub','',true)`;
  await tx.unsafe("set local role service_role");
  try {
    return await tx.savepoint(point => point.unsafe(`select * from ${schema}.save_validated_generated_artifact_version($1,$2,$3,$4::jsonb,$5,$6,$7)`,
      [target, verifiedActor, source, tx.json(candidateManifest), status, status === "failed" ? "Synthetic failure" : "", base]));
  } finally { await authenticate(tx); }
};
try {
  const ledger = await db`select version from supabase_migrations.schema_migrations order by version`;
  const publicAcl = await db`select nspacl::text from pg_namespace where nspname='public'`;
  mkdirSync(".qa", {recursive:true}); writeFileSync(recovery, JSON.stringify({ schema, project }));
  await db.begin(async tx => {
    await tx.unsafe(`create schema ${schema}; create table ${schema}.auth_users(id uuid primary key,email text); grant usage on schema ${schema} to authenticated,service_role`);
    const migrations = readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort().map(file => {
      let sql = readFileSync(`supabase/migrations/${file}`, "utf8");
      if (file.endsWith("_initial.sql")) sql = sql.slice(0, sql.indexOf("insert into storage.buckets"));
      return { file, sql: isolated(sql) };
    });
    await replayMigrations(tx, migrations, "isolated-artifact");
    await testRolePrivileges(tx);
    await tx`insert into ${tx(`${schema}.auth_users`)}(id,email) values(${actor},${`qa-${actor}@example.invalid`}),(${foreign},${`qa-${foreign}@example.invalid`})`;
    await authenticate(tx);
    const [row] = await tx.unsafe(`select * from ${schema}.create_trusted_artifact('custom_comparison','Synthetic version CAS')`);
    artifact = row.id; initial = row.active_version_id;
  });
  created = true;
  // Keep the existing SQL happy paths executable against only this disposable schema.
  try { await db.begin(async tx => {
    await tx.unsafe(isolated(readFileSync("supabase/tests/custom-artifacts.sql", "utf8")));
    throw rollback;
  }); } catch (error) { if (error !== rollback) throw error; }
  console.log("PASS service-only custom artifact SQL happy paths and SDK permission regressions");
  // Stale draft/restore/direct edit all use the same activation transaction.
  try { await db.begin(async tx => {
    await authenticate(tx);
    for (const verifiedActor of [null, foreign]) {
      const before = await snapshot(tx);
      // Restore role outside the savepoint: failed SQL aborts its subtransaction.
      await tx.unsafe("set local role service_role");
      const rejected = await tx.savepoint(point => point.unsafe(`select ${schema}.save_validated_generated_artifact_version($1,$2,$3,$4::jsonb,'validated','',$5)`, [artifact, verifiedActor, 'input => ({summary:"Synthetic"})', point.json(manifest), initial])).then(() => "success", error => error.code);
      await authenticate(tx);
      assert.equal(rejected, verifiedActor === null ? "28000" : "P0002");
      assert.deepEqual(await snapshot(tx), before, "Rejected verified actor leaves all artifact records unchanged");
    }
    // Even a declared permission cannot expand a native kind's SDK contract.
    const [native] = await tx.unsafe(`select * from ${schema}.create_trusted_artifact('spending_explorer','Synthetic scoped tool')`);
    await tx.unsafe("reset role");
    await tx.unsafe(`update ${schema}.artifacts set permissions='["balances"]' where id=$1`, [native.id]);
    await authenticate(tx);
    const kindDenied = await tx.savepoint(point => save(point, native.active_version_id, "Synthetic", "validated", native.id, actor, 'input => ({summary:"Synthetic"})', {...manifest, kind: "spending_explorer", sdk: ["balances"]})).then(() => "success", error => error.code);
    assert.equal(kindDenied, "42501");
    assert.equal((await tx.unsafe(`select count(*)::int n from ${schema}.artifact_versions where artifact_id=$1`, [native.id]))[0].n, 1);
    assert.equal((await tx.unsafe(`select active_version_id from ${schema}.artifacts where id=$1`, [native.id]))[0].active_version_id, native.active_version_id);
    const [first] = await save(tx, initial, "First");
    assert.equal(first.status, "validated"); assert.deepEqual(first.manifest, manifest);
    assert.equal(first.source, '(input) => ({summary:"First"})');
    const staleBefore = await snapshot(tx);
    const stale = await tx.savepoint(async point => save(point, initial, "Stale")).then(() => "success", error => error.code);
    assert.equal(stale, "40001");
    assert.deepEqual(await snapshot(tx), staleBefore, "Stale CAS leaves artifact, history and state unchanged");
    const unknownBase = await tx.savepoint(point => save(point, null, "Unknown base")).then(() => "success", error => error.code);
    assert.equal(unknownBase, "40001", "Unknown legacy draft base cannot bypass CAS");
    const [active] = await tx.unsafe(`select active_version_id from ${schema}.artifacts where id=$1`, [artifact]);
    assert.equal(active.active_version_id, first.id);
    assert.equal((await tx.unsafe(`select count(*)::int n from ${schema}.artifact_versions where artifact_id=$1`, [artifact]))[0].n, 2);
    const failedBefore = await snapshot(tx);
    const [failed] = await save(tx, initial, "Failed", "failed");
    assert.equal(failed.status, "failed"); assert.equal(failed.error, "Synthetic failure");
    const failedAfter = await snapshot(tx);
    assert.deepEqual(failedAfter[0].artifact, failedBefore[0].artifact);
    assert.deepEqual(failedAfter[0].state, failedBefore[0].state);
    for (const sdk of [["unknown"], ["spending"]]) {
      await tx.unsafe("reset role");
      await tx.unsafe(`update ${schema}.artifacts set permissions='[]' where id=$1`, [artifact]);
      const before = await snapshot(tx);
      await tx.unsafe("set local role service_role");
      const deniedSdk = await tx.savepoint(point => point.unsafe(`select ${schema}.save_validated_generated_artifact_version($1,$2,$3,$4::jsonb,'validated','',$5)`, [artifact, actor, 'input => ({summary:"Synthetic"})', point.json({...manifest, sdk}), first.id])).then(() => "success", error => error.code);
      await authenticate(tx);
      assert.equal(deniedSdk, "42501"); assert.deepEqual(await snapshot(tx), before);
    }
    assert.equal((await tx.unsafe(`select active_version_id from ${schema}.artifacts where id=$1`, [artifact]))[0].active_version_id, first.id);
    const oldSave = await tx.savepoint(point => point.unsafe(`select ${schema}.save_generated_artifact_version($1,$2,$3::jsonb,'validated','')`, [artifact, 'input => ({summary:"Synthetic"})', point.json(manifest)])).then(() => "success", error => error.code);
    const oldRename = await tx.savepoint(point => point.unsafe(`select ${schema}.rename_trusted_artifact($1,'Old bypass')`, [artifact])).then(() => "success", error => error.code);
    assert.equal(oldSave, "42501"); assert.equal(oldRename, "42501");
    const staleRename = await tx.savepoint(point => point.unsafe(`select ${schema}.rename_trusted_artifact($1,'Stale rename',$2)`, [artifact, initial])).then(() => "success", error => error.code);
    assert.equal(staleRename, "40001");
    await tx.unsafe(`select ${schema}.rename_trusted_artifact($1,'Current rename',$2)`, [artifact, first.id]);
    console.log("PASS verified actor, SDK scope, stale server saves and authenticated renames rejected atomically; failed attempts retained; old RPC CAS bypass denied");
    let latest = (await tx.unsafe(`select active_version_id from ${schema}.artifacts where id=$1`, [artifact]))[0].active_version_id;
    for (let i = 0; i < 21; i++) [ { id: latest } ] = await save(tx, latest, `History ${i}`);
    const older = await tx.unsafe(`select id,version,source,manifest from ${schema}.artifact_versions where artifact_id=$1 and version<6 order by version desc`, [artifact]);
    assert(older.some(row => row.id === first.id), "First calculator is reachable past 20 newer versions");
    const beforeState = await tx.unsafe(`select state,version from ${schema}.artifact_state where artifact_id=$1`, [artifact]);
    const [restored] = await save(tx, latest, "Restored", "validated", artifact, actor, first.source, first.manifest);
    assert.equal(restored.version, 26); assert.notEqual(restored.id, first.id); assert.equal(restored.source, first.source);
    assert.deepEqual(await tx.unsafe(`select id,version,source,manifest from ${schema}.artifact_versions where artifact_id=$1 and version<6 order by version desc`, [artifact]), older, "Stable keyset excludes newly inserted revisions");
    assert.deepEqual(await tx.unsafe(`select state,version from ${schema}.artifact_state where artifact_id=$1`, [artifact]), beforeState, "Restore preserves saved state");
    console.log("PASS actual SQL history beyond 21 versions, stable keyset, restore creates version 26 and preserves source history/state");
    const [trusted] = await tx.unsafe(`select * from ${schema}.restore_trusted_artifact_version($1,$2,$3)`, [artifact, initial, restored.id]);
    assert.equal(trusted.version, 27);
    assert.notEqual(trusted.id, initial);
    assert.equal(trusted.manifest.runtime, "trusted");
    const [original] = await tx.unsafe(`select source,manifest from ${schema}.artifact_versions where id=$1`, [initial]);
    assert.equal(trusted.source, original.source); assert.deepEqual(trusted.manifest, original.manifest);
    assert.deepEqual(await tx.unsafe(`select state,version from ${schema}.artifact_state where artifact_id=$1`, [artifact]), beforeState);
    const staleRestore = await tx.savepoint(point => point.unsafe(`select ${schema}.restore_trusted_artifact_version($1,$2,$3)`, [artifact, initial, restored.id])).then(() => "success", error => error.code);
    assert.equal(staleRestore, "40001");
    const generatedAsTrusted = await tx.savepoint(point => point.unsafe(`select ${schema}.restore_trusted_artifact_version($1,$2,$3)`, [artifact, first.id, trusted.id])).then(() => "success", error => error.code);
    assert.equal(generatedAsTrusted, "P0002");
    const [sibling] = await tx.unsafe(`select * from ${schema}.create_trusted_artifact('custom_comparison','Synthetic other tool')`);
    const wrongArtifact = await tx.savepoint(point => point.unsafe(`select ${schema}.restore_trusted_artifact_version($1,$2,$3)`, [artifact, sibling.active_version_id, trusted.id])).then(() => "success", error => error.code);
    assert.equal(wrongArtifact, "P0002");
    const mutable = await tx.savepoint(point => point.unsafe(`update ${schema}.artifact_versions set source='unreviewed' where id=$1`, [initial])).then(() => "success", error => error.code);
    assert.equal(mutable, "42501");
    await tx.unsafe("reset role");
    // Check a persisted permission declaration with admin-arranged synthetic history.
    await tx.unsafe(`update ${schema}.artifact_versions set manifest=jsonb_set(manifest,'{sdk}','["spending"]') where id=$1`, [initial]);
    await tx.unsafe(`update ${schema}.artifacts set permissions='[]' where id=$1`, [artifact]);
    await authenticate(tx);
    const revoked = await tx.savepoint(point => point.unsafe(`select ${schema}.restore_trusted_artifact_version($1,$2,$3)`, [artifact, initial, trusted.id])).then(() => "success", error => error.code);
    assert.equal(revoked, "42501");
    await tx.unsafe("reset role");
    // Legacy builtin manifests had only kind/runtime. Keep them reachable too.
    await tx.unsafe(`update ${schema}.artifact_versions set manifest=manifest-'sdk'-'params'-'renderer' where id=$1`, [initial]);
    await authenticate(tx);
    const [legacy] = await tx.unsafe(`select * from ${schema}.restore_trusted_artifact_version($1,$2,$3)`, [artifact, initial, trusted.id]);
    assert.deepEqual(legacy.manifest, {kind:"custom_comparison",runtime:"trusted"});
    assert.deepEqual((await tx.unsafe(`select permissions from ${schema}.artifacts where id=$1`, [artifact]))[0].permissions, []);
    console.log("PASS authenticated trusted v1 restore creates version27, preserves immutable source/manifest/state, rejects stale and generated targets; direct mutation denied");
    console.log("PASS wrong-artifact target denied, revoked declared scope denied, legacy builtin restored without expanding permissions");
    throw rollback;
  }); } catch (error) { if (error !== rollback) throw error; }
  assert.equal((await db.unsafe(`select count(*)::int n from ${schema}.artifact_versions where artifact_id=$1`, [artifact]))[0].n, 1, "Rollback fixture must leave original version only");
  {
    const denied = await db.begin(async tx => { await authenticate(tx, foreign); await save(tx, initial, "Synthetic", "validated", artifact, foreign); }).then(() => "success", error => error.code);
    assert.equal(denied, "P0002");
    const foreignRestore = await db.begin(async tx => { await authenticate(tx, foreign); await tx.unsafe(`select ${schema}.restore_trusted_artifact_version($1,$2,$3)`, [artifact, initial, initial]); }).then(() => "success", error => error.code);
    assert.equal(foreignRestore, "P0002");
    // First transaction activates but holds its row lock; a stale second connection must wait and recheck.
    let ready, pid;
    const locked = new Promise(resolve => { ready = resolve; });
    const unlock = new Promise(resolve => { release = resolve; });
    const holder = db.begin(async tx => { await authenticate(tx); await save(tx, initial, "Winner"); ready(); await unlock; });
    holder.catch(error => ready(error));
    const error = await locked; if (error) throw error;
    const waiter = db.begin(async tx => { await authenticate(tx); [{pid}] = await tx`select pg_backend_pid() pid`; await tx.unsafe(`select ${schema}.restore_trusted_artifact_version($1,$2,$3)`, [artifact, initial, initial]); }).then(() => "success", error => error.code);
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
    console.log("PASS actual concurrent service activation/authenticated trusted-restore RPCs: restore waits, then rejects unseen winner; no losing version inserted");
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
