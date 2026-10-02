// Actual authenticated/service connections; only disposable fixtures are committed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";

process.loadEnvFile(".env");
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const connection = new URL(process.env.SUPABASE_DB_URL);
assert(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`), "Configured project mismatch");
const db = postgres(connection.toString(), { ssl: "require", max: 3, connect_timeout: 10, onnotice: () => {} });
const user = randomUUID(), imported = randomUUID(), account = randomUUID(), dataSource = randomUUID();
const recoveryPath = `.qa/import-concurrency-${user}.json`;
const rowSource = randomUUID(), transaction = randomUUID(), balance = randomUUID();
const overlapA = randomUUID(), overlapB = randomUUID(), overlapSourceA = randomUUID(), overlapSourceB = randomUUID(), overlapTransaction = randomUUID();
let workspace;
const payload = { sourceId: rowSource, transactionId: transaction, balanceId: balance, rowNumber: 2,
  originalRow: { Amount: "-90071992547409.93" }, externalId: "synthetic-concurrent", postedOn: "2026-10-01",
  postedAt: "2026-10-01T08:00:00Z", description: "Synthetic concurrency", amountMinor: "-9007199254740993",
  currencyCode: "EUR", status: "posted", kind: "ordinary", reviewReasons: [], action: "new",
  balanceMinor: "10000", balanceAsOf: "2026-10-01T08:00:00Z", reportProgress: true };

async function service(tx) { await tx.unsafe("set local role service_role"); }
async function authenticated(tx) {
  await tx`select set_config('request.jwt.claim.sub',${user},true)`;
  await tx.unsafe("set local role authenticated");
}
async function ingest(tx, version) {
  await service(tx);
  return (await tx`select public.ingest_import_row(${imported},${workspace},${version},${account},${tx.json(payload)}) result`)[0].result;
}
async function control(tx, action) {
  await authenticated(tx);
  return (await tx`select public.control_import(${imported},${action},${randomUUID()}) result`)[0].result;
}

async function race(holderWork, waiterWork, queryName) {
  let acquired, release;
  let holderPid, waiterPid;
  const locked = new Promise(resolve => { acquired = resolve; });
  const unlock = new Promise(resolve => { release = resolve; });
  const holder = db.begin(async tx => {
    [{ pid: holderPid }] = await tx`select pg_backend_pid() pid`;
    await holderWork(tx); acquired(); await unlock;
  });
  holder.catch(error => acquired(error));
  const lockError = await locked;
  if (lockError) throw lockError;
  const waiter = db.begin(async tx => {
    [{ pid: waiterPid }] = await tx`select pg_backend_pid() pid`;
    return waiterWork(tx);
  }).then(result => ({ result }), error => ({ error }));
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
      blocked = waiterPid !== undefined && (await db`select 1 from pg_stat_activity where pid=${waiterPid}
        and query like ${`%${queryName}%`} and wait_event_type='Lock' and ${holderPid}=any(pg_blocking_pids(pid))`).length > 0;
      if (!blocked) await delay(50);
    }
    assert(blocked, "Concurrent importer/control operation must wait for its scoped row lock");
  } finally { release(); }
  await holder;
  return waiter;
}

try {
  assert.equal((await db`select count(*)::int count from supabase_migrations.schema_migrations where version='202610010051'`)[0].count, 1, "Apply reviewed migration 051 first");
  await db.begin(async tx => {
    await tx`insert into auth.users(id,email) values(${user},${`qa-${user}@example.invalid`})`;
    [{ id: workspace }] = await tx`select id from public.workspaces where owner_id=${user}`;
    await tx`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping)
      values(${imported},${workspace},'synthetic.csv',${`${workspace}/synthetic.csv`},${imported},'queued',1,'{"dateColumn":"Date","descriptionColumn":"Description","amountColumn":"Amount"}')`;
    await service(tx);
    await tx`select public.prepare_import_route(${imported},${workspace},1,${account},${dataSource},'Synthetic concurrency','EUR',1)`;
  });
  mkdirSync(".qa", { recursive: true });
  writeFileSync(recoveryPath, JSON.stringify({ project, user, workspace }));
  const canceledWrite = await race(async tx => {
    assert.equal((await control(tx, "cancel")).status, "canceled");
  }, tx => ingest(tx, 1), "ingest_import_row");
  assert.equal(canceledWrite.error?.code, "57014", "Cancellation winning the lock must reject every row effect");
  assert.equal((await db`select count(*)::int count from public.source_transactions where import_id=${imported}`)[0].count, 0);
  assert.equal((await db`select count(*)::int count from public.transactions where id=${transaction}`)[0].count, 0);
  assert.equal((await db`select count(*)::int count from public.balance_snapshots where id=${balance}`)[0].count, 0);

  assert.equal((await db.begin(tx => control(tx, "resume"))).runVersion, 3);
  await db.begin(async tx => { await service(tx); await tx`select public.prepare_import_route(${imported},${workspace},3,${account},${dataSource},'Synthetic concurrency','EUR',1)`; });
  await assert.rejects(db.begin(tx => ingest(tx, 1)), error => error.code === "57014");
  const stoppedAfterWrite = await race(tx => ingest(tx, 3), tx => control(tx, "cancel"), "control_import");
  assert.equal(stoppedAfterWrite.result?.status, "canceled", "Cancellation after committed ingestion must retain that historical row");
  assert.equal((await db`select amount_minor::text from public.transactions where id=${transaction}`)[0].amount_minor, "-9007199254740993");
  assert.equal((await db`select count(*)::int count from public.source_transactions where import_id=${imported}`)[0].count, 1);
  await assert.rejects(db.begin(tx => ingest(tx, 3)), error => error.code === "57014");

  assert.equal((await db.begin(tx => control(tx, "resume"))).runVersion, 5);
  await db.begin(async tx => { await service(tx); await tx`select public.prepare_import_route(${imported},${workspace},5,${account},${dataSource},'Synthetic concurrency','EUR',1)`; });
  const replayed = await race(tx => ingest(tx, 5), tx => ingest(tx, 5), "ingest_import_row");
  assert.equal(replayed.result?.action, "new");
  for (const [table, id] of [["transactions", transaction], ["source_transactions", rowSource], ["balance_snapshots", balance]]) {
    assert.equal((await db`select count(*)::int count from ${db(`public.${table}`)} where id=${id}`)[0].count, 1, "Concurrent/resumed retries must retain one original record");
  }
  await db.begin(async tx => {
    await service(tx);
    assert.equal((await tx`select public.finish_import_run(${imported},${workspace},3,'Late old worker failure') status`)[0].status, "running");
    assert.equal((await tx`select public.finish_import_run(${imported},${workspace},5,null) status`)[0].status, "completed");
  });
  await db.begin(async tx => {
    for (const id of [overlapA, overlapB]) {
      await tx`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping)
        values(${id},${workspace},'overlap.csv',${`${workspace}/${id}.csv`},${id},'queued',1,'{"dateColumn":"Date","descriptionColumn":"Description","amountColumn":"Amount"}')`;
      await service(tx);
      await tx`select public.prepare_import_route(${id},${workspace},1,${account},${dataSource},'Synthetic concurrency','EUR',1)`;
    }
  });
  const overlapPayload = { ...payload, originalRow: { Amount: "-1.23" }, externalId: "synthetic-overlap", description: "Synthetic overlapping files", amountMinor: "-123", balanceMinor: null, balanceAsOf: null };
  const overlapIngest = async (tx, id, source, canonical) => {
    await service(tx);
    return (await tx`select public.ingest_import_row(${id},${workspace},1,${account},${tx.json({ ...overlapPayload, sourceId: source, transactionId: canonical })}) result`)[0].result;
  };
  const overlap = await race(tx => overlapIngest(tx, overlapA, overlapSourceA, overlapTransaction),
    tx => overlapIngest(tx, overlapB, overlapSourceB, randomUUID()), "ingest_import_row");
  assert.equal(overlap.error?.code, "40001", "Concurrent different files must recheck overlap after the first canonical commit");
  assert.equal((await db`select count(*)::int count from public.transactions where workspace_id=${workspace} and description='Synthetic overlapping files'`)[0].count, 1);
  assert.equal((await db`select count(*)::int count from public.source_transactions where id=${overlapSourceB}`)[0].count, 0, "Rejected stale overlap must leave no source effects");
  await db.begin(async tx => {
    await service(tx);
    const result = (await tx`select public.ingest_import_row(${overlapB},${workspace},1,${account},${tx.json({ ...overlapPayload, sourceId: overlapSourceB, transactionId: overlapTransaction, action: "matched", expectedTransactionVersion: 0 })}) result`)[0].result;
    assert.equal(result.action, "matched");
  });
  assert.equal((await db`select count(*)::int count from public.transactions where workspace_id=${workspace} and description='Synthetic overlapping files'`)[0].count, 1);
  assert.equal((await db`select count(*)::int count from public.transaction_sources where transaction_id=${overlapTransaction}`)[0].count, 2);
  const undoAfterCorrection = await race(async tx => {
    await authenticated(tx);
    await tx`select public.correct_transaction(${transaction},0,'Synthetic corrected description',null)`;
  }, async tx => {
    await authenticated(tx);
    return (await tx`select public.undo_import(${imported},1,1) result`)[0].result;
  }, "undo_import");
  assert.equal(undoAfterCorrection.error?.code, "40001", "Undo must wait for canonical correction, then report the retained audit conflict instead of deadlocking");
  assert.equal((await db`select count(*)::int count from public.transactions where id=${transaction}`)[0].count, 1);
  assert.equal((await db`select status from public.imports where id=${imported}`)[0].status, "completed");
  const archivedWrite = await race(async tx => {
    await authenticated(tx);
    await tx`select public.edit_money_metadata('account',${account},1,'{"archived":true}',${randomUUID()})`;
  }, tx => overlapIngest(tx, overlapA, overlapSourceA, overlapTransaction), "ingest_import_row");
  assert.equal(archivedWrite.error?.code, "42501", "An archive winning the account lock must reject later ingestion");
  await db.begin(async tx => {
    await authenticated(tx);
    await tx`select public.edit_money_metadata('account',${account},2,'{"archived":false}',${randomUUID()})`;
  });
  const pendingImport = randomUUID(), pendingSource = randomUUID(), pendingTransaction = randomUUID();
  await db.begin(async tx => {
    await tx`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping)
      values(${pendingImport},${workspace},'pending.csv',${`${workspace}/pending.csv`},${pendingImport},'queued',1,'{"dateColumn":"Date","descriptionColumn":"Description","amountColumn":"Amount"}')`;
    await service(tx);
    await tx`select public.prepare_import_route(${pendingImport},${workspace},1,${account},${dataSource},'Synthetic concurrency','EUR',1)`;
  });
  const protectedHold = await race(async tx => {
    await service(tx);
    await tx`select public.ingest_import_row(${pendingImport},${workspace},1,${account},${tx.json({ ...overlapPayload, sourceId: pendingSource, transactionId: pendingTransaction, externalId: "synthetic-pending", description: "Synthetic pending hold", status: "pending" })})`;
  }, async tx => {
    await authenticated(tx);
    return tx`select public.edit_money_metadata('account',${account},3,'{"archived":true}',${randomUUID()})`;
  }, "edit_money_metadata");
  assert.equal(protectedHold.error?.code, "22023", "Pending ingestion winning the account lock must prevent later archiving");
  assert.equal((await db`select archived_at from public.accounts where id=${account}`)[0].archived_at, null);
} finally {
  if (workspace) await db.begin(async tx => {
    await tx`delete from public.balance_snapshots where workspace_id=${workspace}`;
    await tx`delete from public.transaction_sources where source_transaction_id in (select id from public.source_transactions where workspace_id=${workspace})`;
    await tx`delete from public.source_transactions where workspace_id=${workspace}`;
    await tx`delete from public.correction_events where workspace_id=${workspace}`;
    await tx`delete from public.transactions where workspace_id=${workspace}`;
    await tx`delete from public.import_control_events where workspace_id=${workspace}`;
    await tx`delete from public.imports where workspace_id=${workspace}`;
    await tx`delete from public.money_metadata_events where workspace_id=${workspace}`;
    await tx`delete from public.data_sources where workspace_id=${workspace}`;
    await tx`delete from public.accounts where workspace_id=${workspace}`;
    await tx`delete from public.categories where workspace_id=${workspace}`;
    await tx`delete from public.merchants where workspace_id=${workspace}`;
    await tx`delete from public.workspaces where id=${workspace} and owner_id=${user}`;
  });
  await db`delete from auth.users where id=${user}`;
  assert.equal((await db`select count(*)::int count from auth.users where id=${user}`)[0].count, 0, "Synthetic user cleanup failed");
  if (existsSync(recoveryPath)) unlinkSync(recoveryPath);
  await db.end();
}
console.log("PASS: real import cancellation locks, stale/cross-file deduplication, correction/undo ordering, archive/hold races and exact money; cleanup verified");
