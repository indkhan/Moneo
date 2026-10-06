// Three real connections; all committed fixtures and RPC definitions live in one disposable schema.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { replayMigrations } from "./migration-replay.mjs";
process.loadEnvFile(".env");
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const connection = new URL(process.env.SUPABASE_DB_URL);
assert(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`));
const db = postgres(connection.toString(), { ssl: "require", max: 3, connect_timeout: 10, onnotice: () => {} });
const schema = `moneo_reservation_qa_${randomUUID().replaceAll("-", "")}`;
assert(/^moneo_reservation_qa_[a-f0-9]{32}$/.test(schema));
const isolated = sql => sql.replace(/\bpublic\./g, `${schema}.`).replace(/\bschema public\b/g, `schema ${schema}`).replace(/\bauth\.users\b/g, `${schema}.auth_users`);
const actor = randomUUID(), foreignActor = randomUUID();
let created = false, release;
async function authenticated(tx, user = actor) {
  await tx.unsafe("set local lock_timeout='8s'; set local statement_timeout='12s'");
  await tx`select set_config('request.jwt.claim.sub',${user},true)`;
  await tx.unsafe("set local role authenticated");
}
async function interleave(holderWork, waiterWork) {
  let ready;
  const locked = new Promise(resolve => { ready = resolve; });
  const unlock = new Promise(resolve => { release = resolve; });
  const holder = db.begin(async tx => { await authenticated(tx); const result = await holderWork(tx); ready(); await unlock; return result; });
  holder.catch(error => ready(error));
  const error = await locked; if (error) throw error;
  let pid, started;
  const waiter = db.begin(async tx => {
    await authenticated(tx); [{ pid, started }] = await tx`select pg_backend_pid() pid, clock_timestamp() started`; return waiterWork(tx);
  }).then(value => ({ value }), error => ({ code: error.code }));
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      if (pid) blocked = (await db`select 1 from pg_stat_activity where pid=${pid} and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0`).length > 0;
      if (!blocked) await delay(20);
    }
    assert(blocked, "The actual RPC must wait on the holder's account lock");
  } finally { release(); }
  const outcomes = await Promise.all([holder, waiter]);
  return [...outcomes, started];
}
try {
  const history = await db`select version from supabase_migrations.schema_migrations order by version`;
  const acl = await db`select nspacl::text from pg_namespace where nspname='public'`;
  await db.begin(async tx => {
    await tx.unsafe(`create schema ${schema}; create table ${schema}.auth_users(id uuid primary key,email text); grant usage on schema ${schema} to authenticated,service_role`);
    const migrations = readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort().map(file => {
      let sql = readFileSync(`supabase/migrations/${file}`, "utf8");
      if (file.endsWith("_initial.sql")) sql = sql.slice(0, sql.indexOf("insert into storage.buckets"));
      return { file, sql: isolated(sql) };
    });
    await replayMigrations(tx, migrations, "isolated-reservation-race");
    await tx.unsafe(`insert into ${schema}.auth_users(id,email) values($1,$2),($3,$4)`, [actor, `qa-${actor}@example.invalid`, foreignActor, `qa-${foreignActor}@example.invalid`]);
  });
  created = true;
  const [{ id: workspace }] = await db.unsafe(`select id from ${schema}.workspaces where owner_id=$1`, [actor]);
  const [{ today }] = await db`select (clock_timestamp() at time zone 'Europe/Berlin')::date::text today`;
  for (const balanceFirst of [true, false]) {
    const account = randomUUID(), goal = randomUUID(), baseline = randomUUID(), balanceRequest = randomUUID(), reserveRequest = randomUUID();
    await db.begin(async tx => {
      await tx.unsafe(`insert into ${schema}.accounts(id,workspace_id,name,currency_code) values($1,$2,'Synthetic race cash','EUR')`, [account, workspace]);
      await tx.unsafe(`insert into ${schema}.goals(id,workspace_id,name,target_minor,currency_code) values($1,$2,'Synthetic race goal',20000,'EUR')`, [goal, workspace]);
      await tx.unsafe(`insert into ${schema}.balance_snapshots(id,workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind,covered_transactions,actor_id) values($1,$2,$3,10000,'EUR',clock_timestamp()-interval '1 minute','manual','reviewed_activity','[]',$4)`, [baseline, workspace, account, actor]);
    });
    const balance = tx => tx.unsafe(`select ${schema}.record_manual_balance($1,'5000',$2,true,'[]',$3,1,$4) receipt`, [account, today, baseline, balanceRequest]);
    const reserve = tx => tx.unsafe(`select ${schema}.reserve_goal_funds($1,$2,'9000',0,$3) receipt`, [goal, account, reserveRequest]);
    const [holder, waiter, waiterStarted] = await interleave(balanceFirst ? balance : reserve, balanceFirst ? reserve : balance);
    const [evidence] = await db.unsafe(`select ${schema}.reservation_balance_evidence($1,clock_timestamp(),'Europe/Berlin') evidence`, [account]);
    assert.equal(evidence.evidence.amount_minor, "5000", "Real cash must be recorded even if it creates a virtual funding deficit");
    const allocations = await db.unsafe(`select amount_minor::text amount from ${schema}.goal_allocations where account_id=$1`, [account]);
    if (balanceFirst) {
      assert.equal(waiter.code, "22003", "Reservation must evaluate the newly committed lower balance");
      assert.equal(allocations.length, 0);
      assert.equal((await db.unsafe(`select 1 from ${schema}.goal_reservation_events where request_id=$1`, [reserveRequest])).length, 0);
    } else {
      assert(waiter.value, "The actual lower cash balance must commit after the reservation");
      assert.equal(allocations[0].amount, "9000");
      assert.equal(BigInt(evidence.evidence.amount_minor) - BigInt(allocations[0].amount), -4000n, "Deficit remains visible, cash cannot be fabricated to protect a reservation");
      const [event] = await db.unsafe(`select after,undone_at from ${schema}.goal_reservation_events where request_id=$1`, [reserveRequest]);
      assert.equal(event.after.amount_minor, "9000"); assert.equal(event.undone_at, null);
      assert.equal(holder[0].receipt.undone, false);
    }
    const [snapshot] = await db.unsafe(`select as_of,covered_transactions,amount_minor::text amount from ${schema}.balance_snapshots where id=$1`, [balanceRequest]);
    assert.equal(snapshot.amount, "5000"); assert.deepEqual(snapshot.covered_transactions, []);
    if (!balanceFirst) assert(snapshot.as_of >= waiterStarted, "Reviewed boundary must be captured after waiting for the account lock, not at command entry");
    assert.equal((await db.unsafe(`select 1 from ${schema}.balance_snapshots where id=$1`, [baseline])).length, 1, "Prior snapshot history survives");
    const denied = await db.begin(async tx => { await authenticated(tx, foreignActor); return reserve(tx); }).then(() => "accepted", error => error.code);
    assert.equal(denied, "P0002", "A second workspace cannot read/write this account through the RPC");
  }
  // Existing exact-coverage, stale financial correction, idempotent retry and undo
  // acceptance fixtures also execute against these current isolated RPC definitions.
  const rollback = new Error("Acceptance fixtures rolled back");
  try { await db.begin(async tx => { await tx.unsafe(isolated(readFileSync("supabase/tests/reviewed-balances.sql", "utf8"))); throw rollback; }); }
  catch (error) { if (error !== rollback) throw error; }
  assert.deepEqual(await db`select version from supabase_migrations.schema_migrations order by version`, history);
  assert.deepEqual(await db`select nspacl::text from pg_namespace where nspname='public'`, acl);
  console.log("PASS: both account-lock orderings observed; lower cash prevents reservation or preserves its receipt with a 4000-minor deficit; cross-workspace access rejected");
} finally {
  release?.();
  if (created) { await db.unsafe(`drop schema ${schema} cascade`); assert.equal((await db`select 1 from pg_namespace where nspname=${schema}`).length, 0); }
  await db.end();
}
