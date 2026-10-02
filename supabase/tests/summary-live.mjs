// Actual cron HTTP dispatch and durable review; only a disposable synthetic workspace is cleaned up.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";

process.loadEnvFile(".env");
assert(process.env.CRON_SECRET, "Configure CRON_SECRET in the local app and test environment");
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const connection = new URL(process.env.SUPABASE_DB_URL);
assert(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`), "Configured project mismatch");
const db = postgres(connection.toString(), { ssl: "require", max: 1 });
const user = randomUUID(), recoveryPath = `.qa/summary-${user}.json`;
mkdirSync(".qa", { recursive: true });
let workspace;
async function cron() {
  const response = await fetch("http://localhost:3000/api/cron/summaries", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(response.status, 200, "Authenticated cron must dispatch successfully");
  return response.json();
}
try {
  await db.begin(async tx => {
    await tx`insert into auth.users(id,email) values(${user},${`qa-${user}@example.invalid`})`;
    [{ id: workspace }] = await tx`select id from public.workspaces where owner_id=${user}`;
    await tx`insert into public.workspace_settings(workspace_id,summary_cadence,summary_time,ai_data_scopes) values(${workspace},'weekly','00:00',array['accounts','transactions'])`;
  });
  writeFileSync(recoveryPath, JSON.stringify({ project, user, workspace }));
  await cron();
  let rows = await db`select j.id,j.status from public.summary_runs r join public.background_jobs j on j.id=r.job_id where r.workspace_id=${workspace} and cadence='weekly'`;
  assert.equal(rows.length, 1, "Enabled summary must create one durable period receipt");
  const first = rows[0].id;
  await cron();
  assert.equal((await db`select count(*)::integer count from public.summary_runs where workspace_id=${workspace}`)[0].count, 1, "Repeated cron must not dispatch another job for the same period");
  for (let attempt = 0; attempt < 120; attempt++) {
    rows = await db`select id,status from public.background_jobs where id=${first} and workspace_id=${workspace}`;
    if (["completed", "failed", "canceled"].includes(rows[0].status)) break;
    await delay(1000);
  }
  assert.equal(rows[0].status, "completed", "Real scheduled free-model review must complete");
  assert.equal((await db`select count(*)::integer count from public.saved_analyses where workspace_id=${workspace} and job_id=${first}`)[0].count, 1);
  await db`update public.workspace_settings set summary_cadence='monthly' where workspace_id=${workspace}`;
  await cron();
  const monthly = await db`select job_id from public.summary_runs where workspace_id=${workspace} and cadence='monthly'`;
  assert.equal(monthly.length, 1);
  await db.begin(async tx => {
    await tx`select set_config('request.jwt.claim.sub',${user},true)`;
    await tx.unsafe("set local role authenticated");
    assert.equal((await tx`select public.cancel_financial_review(${monthly[0].job_id}) status`)[0].status, "canceled");
  });
  await db`update public.workspace_settings set summary_cadence='none' where workspace_id=${workspace}`;
  await cron();
  await delay(3000);
  assert.equal((await db`select status from public.background_jobs where id=${monthly[0].job_id}`)[0].status, "canceled");
  assert.equal((await db`select count(*)::integer count from public.saved_analyses where job_id=${monthly[0].job_id}`)[0].count, 0);
  assert.equal((await db`select count(*)::integer count from public.summary_runs where workspace_id=${workspace}`)[0].count, 2);
  console.log("PASS: actual authenticated cron/free-model workflow completes; period deduplication, cancellation and disabled cadence prevent extra results");
} finally {
  if (workspace) await db.begin(async tx => {
    await tx`update public.workspace_settings set summary_cadence='none' where workspace_id=${workspace}`;
    await tx`update public.background_jobs set status='canceled',cancel_requested=true where workspace_id=${workspace} and status in ('queued','running')`;
    await tx`delete from public.saved_analyses where workspace_id=${workspace}`;
    await tx`delete from public.summary_runs where workspace_id=${workspace}`;
    await tx`delete from public.background_jobs where workspace_id=${workspace}`;
    await tx`delete from public.workspace_settings where workspace_id=${workspace}`;
    await tx`delete from public.workspaces where id=${workspace} and owner_id=${user}`;
    await tx`delete from auth.users where id=${user}`;
  });
  assert.equal((await db`select 1 from auth.users where id=${user}`).length, 0, "Synthetic summary cleanup must complete");
  if (existsSync(recoveryPath)) unlinkSync(recoveryPath);
  await db.end();
}
