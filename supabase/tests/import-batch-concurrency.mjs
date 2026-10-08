import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import postgres from "postgres";

process.loadEnvFile(".env");
const connection = new URL(process.env.SUPABASE_DB_URL), project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
assert(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`));
const options = { ssl: "require", max: 1, onnotice: () => {}, connection: { application_name: "mne015-batch-race", lock_timeout: "10s", statement_timeout: "120s" } };
const db = postgres(connection.toString(), options), holder = postgres(connection.toString(), options), waiter = postgres(connection.toString(), options), overlap = postgres(connection.toString(), options);
const schema = `mne015_concurrency_qa_${randomUUID().replaceAll("-", "")}`, actor = randomUUID();
const names = ["import_staging", "prevent_import_staging_update", "read_import_stage", "stage_import_rows", "import_batch_candidates", "ingest_import_batch"];
let sql = readFileSync("supabase/migrations/202610070015_normalized_import_batches.sql", "utf8").split("-- Deployment indexes:")[0];
for (const name of names) sql = sql.replaceAll(`public.${name}`, `${schema}.${name}`);
const journal = `.qa/mne015-concurrency-${actor}.json`; mkdirSync(".qa", { recursive: true });
let workspace, releaseOnFailure, workersClosing;
async function closeWorkers() {
  workersClosing ??= Promise.allSettled([holder.end(), waiter.end(), overlap.end()]);
  const results = await workersClosing;
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stage(imported, account, source) {
  await db`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping) values(${imported},${workspace},'race.csv',${workspace + '/race.csv'},${imported},'queued',1,'{"rowContractVersion":"normalized-row-v1","accountName":"Batch race","currencyCode":"EUR","dateColumn":"Date","descriptionColumn":"Description","amountColumn":"Amount","dateFormat":"iso","amountSign":"signed"}')`;
  await db`select public.prepare_import_route(${imported},${workspace},1,${account},${source},'Batch race','EUR',1)`;
  const [{ rows }] = await db`select jsonb_build_array(jsonb_build_object('accountId',${account}::uuid,'excluded',false,'row',jsonb_build_object('accountName','Batch race','sourceId',public.stable_import_uuid(${imported}::text||':row:2'),'balanceId',public.stable_import_uuid(${imported}::text||':balance:2'),'rowNumber',2,'originalRow',jsonb_build_object('Amount','90071992547409.93'),'postedOn','2026-10-01','description','Same synthetic overlap','amountMinor','9007199254740993','currencyCode','EUR','status','posted','kind','ordinary','reviewReasons','[]'::jsonb))) rows`;
  await db.unsafe(`select ${schema}.stage_import_rows($1::uuid,$2::uuid,1,$3::text,(select mapping from public.imports where id=$1::uuid),(select route_accounts from public.imports where id=$1::uuid),(select source_id from public.imports where id=$1::uuid),$4::jsonb)`, [imported, workspace, imported, rows]);
}
const ingest = (client, imported, action = "new", version = 1) => client.unsafe(`select ${schema}.ingest_import_batch($1::uuid,$2::uuid,$3::integer,0,$4::jsonb)`, [imported, workspace, version, [{ rowNumber: 2, action }]]);
try {
  const history = await db`select version from supabase_migrations.schema_migrations order by version`;
  writeFileSync(journal, JSON.stringify({ actor, schema, project }));
  try {
  await db.unsafe(`create schema ${schema}; grant usage on schema ${schema} to service_role`); await db.unsafe(sql);
  await db`insert into auth.users(id,email,raw_user_meta_data) values(${actor},${`qa-batch-race-${actor}@example.invalid`},'{"qa_test":"mne015-batch-race"}')`;
  [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${actor}`;
  writeFileSync(journal, JSON.stringify({ actor, workspace, schema, project }));
  const account = randomUUID(), source = randomUUID(), first = randomUUID(), second = randomUUID();
  await stage(first, account, source); await stage(second, account, source);
  const [{ pid: holderPid }] = await holder`select pg_backend_pid() pid`, [{ pid: waiterPid }] = await waiter`select pg_backend_pid() pid`, [{ pid: overlapPid }] = await overlap`select pg_backend_pid() pid`;
  const [{ result: beforeOverlap }] = await db.unsafe(`select ${schema}.import_batch_candidates($1::uuid,$2::uuid,1,0) result`, [second, workspace]);
  assert.equal(beforeOverlap[0].candidates.length, 0);
  let entered; const enteredBatch = new Promise(resolve => { entered = resolve; });
  let release; const releaseBatch = new Promise(resolve => { release = resolve; releaseOnFailure = resolve; });
  const posting = holder.begin(async tx => { await tx.unsafe("set local role service_role"); await ingest(tx, first); entered(); await releaseBatch; });
  await enteredBatch;
  const overlappingRace = overlap.begin(async tx => { await tx.unsafe("set local role service_role"); await ingest(tx, second); }).then(() => null, error => error);
  let acknowledged = false;
  const cancellation = waiter.begin(async tx => { await tx`select set_config('request.jwt.claim.sub',${actor},true)`; await tx.unsafe("set local role authenticated"); const result = await tx`select public.control_import(${first},'cancel',${randomUUID()}) as result`; acknowledged = true; return result[0].result; });
  let blocked = false;
  for (let attempts = 0; attempts < 100; attempts++) {
    const [{ held, overlap_held: overlapHeld }] = await db`select ${holderPid}::integer=any(pg_blocking_pids(${waiterPid}::integer)) held,${holderPid}::integer=any(pg_blocking_pids(${overlapPid}::integer)) overlap_held`;
    if (held && overlapHeld) { blocked = true; break; } await sleep(50);
  }
  assert(blocked, "Real cancellation must wait for the specific in-flight batch transaction"); assert(!acknowledged);
  assert.equal((await db`select id from public.source_transactions where import_id=${first}`).length, 0, "Uncommitted batch progress must remain invisible");
  release(); await posting; const stopped = await cancellation;
  assert.equal((await overlappingRace)?.code, "40001", "Concurrent overlapping batch must reject its stale new decision after the account lock releases");
  assert.equal(stopped.status, "canceled"); assert.equal((await db`select id from public.source_transactions where import_id=${first}`).length, 1);
  await assert.rejects(ingest(db, first), error => error.code === "57014");
  const resumed = await db.begin(async tx => { await tx`select set_config('request.jwt.claim.sub',${actor},true)`; await tx.unsafe("set local role authenticated"); return (await tx`select public.control_import(${first},'resume',${randomUUID()}) result`)[0].result; });
  await assert.rejects(ingest(db, first), error => error.code === "57014");
  await Promise.all([ingest(holder, first, "new", resumed.runVersion), ingest(waiter, first, "new", resumed.runVersion)]);
  assert.equal((await db`select id from public.transactions where workspace_id=${workspace}`).length, 1);
  // Both workers may prefetch before another batch commits. The row core must
  // reject the stale new decision; a fresh overlap decision is review.
  await assert.rejects(ingest(db, second), error => error.code === "40001");
  const [{ result: candidates }] = await db.unsafe(`select ${schema}.import_batch_candidates($1::uuid,$2::uuid,1,0) result`, [second, workspace]);
  assert.equal(candidates[0].candidates.length, 1); assert.equal(candidates[0].candidates[0].version, 0);
  await ingest(db, second, "review");
  const [{ count, amount }] = await db`select count(*)::integer count,sum(amount_minor)::text amount from public.transactions where workspace_id=${workspace}`;
  assert.equal(count, 1); assert.equal(amount, "9007199254740993");
  assert.equal((await db`select id from public.source_transactions where import_id=${second} and status='review'`).length, 1);
  console.log("PASS: actual in-flight batch/cancel lock waiter, invisible uncommitted progress, resume fencing, concurrent retries and overlap review preserve exact financial/source effects");
} finally {
  releaseOnFailure?.();
  await closeWorkers();
  if (workspace) {
    assert.equal((await db`select w.id from public.workspaces w join auth.users u on u.id=w.owner_id where w.id=${workspace} and w.owner_id=${actor} and u.raw_user_meta_data->>'qa_test'='mne015-batch-race'`).length, 1);
    await db.begin(async tx => {
      await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
      for (const row of await tx`select id from public.imports where workspace_id=${workspace} and status in('queued','running')`) await tx`select public.control_import(${row.id},'cancel',${randomUUID()})`;
      await tx.unsafe(`drop schema ${schema} cascade`);
      await tx`delete from public.transaction_sources where source_transaction_id in(select id from public.source_transactions where workspace_id=${workspace})`;
      for (const table of ["import_control_events", "balance_snapshots", "transactions", "source_transactions", "imports", "data_sources", "accounts"]) await tx`delete from ${tx("public." + table)} where workspace_id=${workspace}`;
      await tx`delete from public.workspaces where id=${workspace} and owner_id=${actor}`;
      await tx`delete from auth.users where id=${actor}`;
    });
    assert.equal((await db`select id from public.workspaces where id=${workspace} or owner_id=${actor}`).length, 0);
    assert.equal((await db`select id from auth.users where id=${actor}`).length, 0);
  } else { await db.unsafe(`drop schema if exists ${schema} cascade`); }
  assert.equal((await db`select 1 from pg_namespace where nspname=${schema}`).length, 0);
  assert.deepEqual(await db`select version from supabase_migrations.schema_migrations order by version`, history);
  unlinkSync(journal); console.log("PASS: precisely owned schema/auth/workspace cleanup zero; migration history unchanged");
}
} finally {
  releaseOnFailure?.();
  try { await closeWorkers(); } finally { await db.end(); }
}
