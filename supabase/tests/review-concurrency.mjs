// Real database roles/connections; committed synthetic fixtures are removed by exact IDs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";

process.loadEnvFile(".env");
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const connection = new URL(process.env.SUPABASE_DB_URL);
assert(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`), "Configured project mismatch");
const db = postgres(connection.toString(), { ssl: "require", max: 3, connect_timeout: 10 });
const user = randomUUID(), job = randomUUID(), permissionsJob = randomUUID(), completedJob = randomUUID();
let workspace;

async function finish(tx, target) {
  await tx.unsafe("set local role service_role");
  return (await tx`select public.finish_financial_review(${target},${workspace},'Synthetic review','Synthetic body','{}',false) status`)[0].status;
}

async function whileBlocked(holderWork, waitingWork, queryName, expected = "canceled") {
  let acquired, release;
  const locked = new Promise(resolve => { acquired = resolve; });
  const unlock = new Promise(resolve => { release = resolve; });
  const holder = db.begin(async tx => {
    await holderWork(tx);
    acquired();
    await unlock;
  });
  holder.catch(error => acquired(error));
  const lockError = await locked;
  if (lockError) throw lockError;
  const waiter = db.begin(waitingWork);
  // Observe rejection immediately while the lock holder is still alive.
  waiter.catch(() => {});
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      const rows = await db`select 1 from pg_stat_activity where pid<>pg_backend_pid()
        and query like ${`%${queryName}%`} and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0`;
      blocked = rows.length > 0;
      if (!blocked) await delay(20);
    }
    assert(blocked, "Finisher must wait for the concurrent authorization/cancellation change");
  } finally { release(); }
  await holder;
  assert.equal(await waiter, expected);
}

try {
  await db.begin(async tx => {
    await tx`insert into auth.users(id,email) values(${user},${`qa-${user}@example.invalid`})`;
    [{ id: workspace }] = await tx`select id from public.workspaces where owner_id=${user}`;
    await tx`insert into public.background_jobs(id,workspace_id,kind) values(${job},${workspace},'financial_review'),(${permissionsJob},${workspace},'financial_review'),(${completedJob},${workspace},'financial_review')`;
  });
  await whileBlocked(async tx => {
    await tx`select set_config('request.jwt.claim.sub',${user},true)`;
    await tx.unsafe("set local role authenticated");
    assert.equal((await tx`select public.cancel_financial_review(${job}) status`)[0].status, "cancel_requested");
  }, tx => finish(tx, job), "finish_financial_review");
  await whileBlocked(async tx => {
    await tx`select set_config('request.jwt.claim.sub',${user},true)`;
    await tx.unsafe("set local role authenticated");
    // Exercise the first preference insert, not only updates of an existing row.
    await tx`insert into public.workspace_settings(workspace_id,ai_data_scopes) values(${workspace},array['accounts'])`;
  }, tx => finish(tx, permissionsJob), "finish_financial_review");
  assert.equal((await db`select count(*)::integer count from public.saved_analyses where workspace_id=${workspace}`)[0].count, 0);
  assert.equal((await db`select count(*)::integer count from public.background_jobs where workspace_id=${workspace} and status='canceled'`)[0].count, 2);
  await db`update public.workspace_settings set ai_data_scopes=array['accounts','transactions'] where workspace_id=${workspace}`;
  await whileBlocked(async tx => {
    assert.equal(await finish(tx, completedJob), "completed");
  }, async tx => {
    await tx`select set_config('request.jwt.claim.sub',${user},true)`;
    await tx.unsafe("set local role authenticated");
    return (await tx`select public.cancel_financial_review(${completedJob}) status`)[0].status;
  }, "cancel_financial_review", "completed");
  assert.equal((await db`select count(*)::integer count from public.saved_analyses where workspace_id=${workspace} and job_id=${completedJob} and body='Synthetic body'`)[0].count, 1);
  console.log("PASS: real cancellation/scope revocation win without analysis; completed finisher wins and retains its historical analysis");
} finally {
  await db.begin(async tx => {
    await tx`delete from public.saved_analyses where workspace_id=${workspace ?? null}`;
    await tx`delete from public.background_jobs where id in (${job},${permissionsJob},${completedJob}) and workspace_id=${workspace ?? null}`;
    await tx`delete from public.workspace_settings where workspace_id=${workspace ?? null}`;
    await tx`delete from public.workspaces where id=${workspace ?? null} and owner_id=${user}`;
    await tx`delete from auth.users where id=${user}`;
  });
  assert.equal((await db`select 1 from auth.users where id=${user}`).length, 0, "Synthetic user cleanup must complete");
  await db.end();
}
