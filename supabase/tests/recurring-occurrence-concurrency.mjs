// Real concurrent connections against a disposable application schema; public data/history are unchanged.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { replayMigrations } from "./migration-replay.mjs";
process.loadEnvFile(".env");
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const connection = new URL(process.env.SUPABASE_DB_URL);
assert(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`), "Configured project mismatch");
const db = postgres(connection.toString(), { ssl: "require", max: 4, connect_timeout: 10, onnotice: () => {} });
const schema = `moneo_occurrence_qa_${randomUUID().replaceAll("-", "")}`;
assert(/^moneo_occurrence_qa_[a-f0-9]{32}$/.test(schema));
const isolated = sql => sql.replace(/\bpublic\./g, `${schema}.`).replace(/\bschema public\b/g, `schema ${schema}`).replace(/\bauth\.users\b/g, `${schema}.auth_users`);
const actor = randomUUID(), account = randomUUID(), otherAccount = randomUUID(), assumption = randomUUID(), transaction = randomUUID(), counterpart = randomUUID(), series = randomUUID();
const recovery = `.qa/${schema}.json`;
let releaseHolder, createdSchema = false;
try {
  const history = await db`select version from supabase_migrations.schema_migrations order by version`;
  const publicAcl = await db`select nspacl::text from pg_namespace where nspname='public'`;
  mkdirSync(".qa", { recursive: true }); writeFileSync(recovery, JSON.stringify({ schema, project }));
  await db.begin(async tx => {
    await tx.unsafe(`create schema ${schema}; create table ${schema}.auth_users(id uuid primary key,email text); grant usage on schema ${schema} to authenticated,service_role`);
    const migrations = readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort().map(file => {
      let sql = readFileSync(`supabase/migrations/${file}`, "utf8");
      if (file.endsWith("_initial.sql")) sql = sql.slice(0, sql.indexOf("insert into storage.buckets"));
      return { file, sql: isolated(sql) };
    });
    await replayMigrations(tx, migrations, "isolated-concurrency");
    // Arrange the posting lock under the authenticated role without granting direct ledger edits.
    await tx.unsafe(`create function ${schema}.lock_posting(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
      begin perform 1 from ${schema}.transactions where id=p_id and ${schema}.owns_workspace(workspace_id) for update; end $$;
      revoke all on function ${schema}.lock_posting(uuid) from public; grant execute on function ${schema}.lock_posting(uuid) to authenticated`);
    await tx`insert into ${tx(`${schema}.auth_users`)}(id,email) values(${actor},${`qa-${actor}@example.invalid`})`;
    const [{ id: workspace }] = await tx`select id from ${tx(`${schema}.workspaces`)} where owner_id=${actor}`;
    await tx`insert into ${tx(`${schema}.accounts`)}(id,workspace_id,name,currency_code) values(${account},${workspace},'Concurrent recurrence','EUR'),(${otherAccount},${workspace},'Concurrent counterpart','EUR')`;
    await tx`insert into ${tx(`${schema}.financial_assumptions`)}(id,workspace_id,account_id,kind,name,amount_minor,currency_code,cadence,starts_on,source,confirmed,enabled) values(${assumption},${workspace},${account},'expense','Confirmed recurrence',-10000,'EUR','monthly','2026-10-06','recurring_confirmed',true,true)`;
    await tx`insert into ${tx(`${schema}.transactions`)}(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind) values(${transaction},${workspace},${account},'2026-10-06','Confirmed recurrence',-10000,'EUR','posted','ordinary'),(${counterpart},${workspace},${otherAccount},'2026-10-06','Transfer counterpart',10000,'EUR','posted','ordinary')`;
    await tx`insert into ${tx(`${schema}.recurring_series`)}(id,workspace_id,account_id,label,normalized_label,cadence,currency_code,amount_min_minor,amount_max_minor,occurrences,confidence,status,assumption_id) values(${series},${workspace},${account},'Confirmed recurrence','confirmed recurrence','monthly','EUR',-10000,-10000,3,90,'confirmed',${assumption})`;
    await tx`insert into ${tx(`${schema}.recurring_series_transactions`)}(workspace_id,series_id,transaction_id) values(${workspace},${series},${transaction})`;
  });
  createdSchema = true;
  let ready, startUpdate, updateFinished;
  const locked = new Promise(resolve => { ready = resolve; });
  const updateRequested = new Promise(resolve => { startUpdate = resolve; });
  const updated = new Promise(resolve => { updateFinished = resolve; });
  const unlock = new Promise(resolve => { releaseHolder = resolve; });
  const holder = db.begin(async tx => {
    await tx.unsafe("set local lock_timeout='8s'; set local statement_timeout='12s'");
    await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
    await tx.unsafe("set local role authenticated");
    await tx.unsafe(`select ${schema}.lock_posting($1)`, [transaction]);
    ready(); await updateRequested;
    // Exercise the real correction RPC and its recurring evidence trigger under the authenticated role.
    await tx.unsafe(`select ${schema}.link_transactions('transfer',$1,0,$2,0,null,'[]'::jsonb,$3)`, [transaction, counterpart, randomUUID()]);
    updateFinished(null); await unlock;
  });
  holder.catch(error => { ready(error); updateFinished(error); });
  const lockError = await locked; if (lockError) throw lockError;
  let waiterPid;
  const waiter = db.begin(async tx => {
    await tx.unsafe("set local lock_timeout='8s'; set local statement_timeout='12s'");
    await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
    await tx.unsafe("set local role authenticated");
    [{ pid: waiterPid }] = await tx`select pg_backend_pid() as pid`;
    await tx.unsafe(`select ${schema}.record_recurring_occurrence($1,1,'2026-10-06',$2,0,true)`, [assumption, transaction]);
  }).then(() => ({ code: "success" }), error => ({ code: error.code }));
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      if (waiterPid) blocked = (await db`select 1 from pg_stat_activity where pid=${waiterPid} and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0`).length > 0;
      if (!blocked) await delay(20);
    }
    assert(blocked, "Association must wait on the concurrently locked transaction");
    startUpdate();
    const updateError = await updated;
    assert.equal(updateError, null, "Existing transaction correction must acquire its assumption without deadlock");
  } finally { startUpdate(); releaseHolder(); }
  const [holderOutcome, waiterOutcome] = await Promise.allSettled([holder, waiter]);
  assert.equal(holderOutcome.status, "fulfilled", "Financial correction must commit in the isolated schema");
  assert.equal(waiterOutcome.status, "fulfilled");
  assert.equal(waiterOutcome.value.code, "40001", "Waiting association must recheck changed assumption/transaction versions");
  assert.equal((await db.unsafe(`select count(*)::int as count from ${schema}.recurring_occurrence_settlements`))[0].count, 0, "Stale association must not persist");
  const [changed] = await db.unsafe(`select enabled,confirmed from ${schema}.financial_assumptions where id=$1`, [assumption]);
  assert.equal(changed.enabled, false); assert.equal(changed.confirmed, false);
  assert.deepEqual(await db`select version from supabase_migrations.schema_migrations order by version`, history, "Public migration history must remain unchanged");
  assert.deepEqual(await db`select nspacl::text from pg_namespace where nspname='public'`, publicAcl, "Public schema privileges must remain unchanged");
  console.log("PASS: concurrent transaction correction and association share transaction-first lock order; stale association rejected, original evidence invalidation retained");
} finally {
  releaseHolder?.();
  if (createdSchema) {
    await db.unsafe(`drop schema ${schema} cascade`);
    assert.equal((await db`select 1 from pg_namespace where nspname=${schema}`).length, 0, "Disposable concurrency schema cleanup must be verified");
  }
  unlinkSync(recovery);
  await db.end();
}
