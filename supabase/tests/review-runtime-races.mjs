import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Only called with this issue's freshly replayed disposable schema, never public.
export async function reviewRuntimeRaces(db, schema) {
  assert.match(schema, /^mne020_[a-f0-9]{32}$/);
  const actor = randomUUID(), election = randomUUID(), cancelFirst = randomUUID(), finishFirst = randomUUID(), deadlineFirst = randomUUID(), registerFirst = randomUUID(), publishBeforeDeadline = randomUUID();
  let workspace;
  await db.begin(async tx => {
    await tx`insert into ${tx(`${schema}.auth_users`)}(id,email) values(${actor},${`qa-${actor}@example.invalid`})`;
    [{id: workspace}] = await tx`select id from ${tx(`${schema}.workspaces`)} where owner_id=${actor}`;
    for (const id of [election, cancelFirst, finishFirst, deadlineFirst, registerFirst, publishBeforeDeadline]) await tx`insert into ${tx(`${schema}.background_jobs`)}(id,workspace_id,kind) values(${id},${workspace},'financial_review')`;
  });
  const register = (tx, job, run) => tx.unsafe(`select ${schema}.register_financial_review_run($1,$2,$3) value`, [job, workspace, run]).then(rows => rows[0].value);
  const finish = (tx, job) => tx.unsafe(`select ${schema}.finish_financial_review($1,$2,'Synthetic','Synthetic body','{}',false) value`, [job, workspace]).then(rows => rows[0].value);
  const expireOrphan = (tx, job) => tx.unsafe(`update ${schema}.background_jobs set status='failed',stage='dispatch_deadline',error='Synthetic expired dispatch',updated_at=now()
    where id=$1 and workspace_id=$2 and kind='financial_review' and workflow_run_id is null and cancel_requested=false and status in('queued','running') returning id`, [job, workspace]).then(rows => rows.length);
  const cancel = async (tx, job) => {
    await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
    await tx.unsafe("set local role authenticated");
    return (await tx.unsafe(`select ${schema}.cancel_financial_review($1) value`, [job]))[0].value;
  };
  async function race(holderWork, waiterWork, expected) {
    let acquired, release;
    const locked = new Promise(resolve => { acquired = resolve; });
    const unlock = new Promise(resolve => { release = resolve; });
    const holder = db.begin(async tx => { await holderWork(tx); acquired(); await unlock; });
    holder.catch(error => acquired(error));
    const holderError = await locked; if (holderError) throw holderError;
    const waiter = db.begin(waiterWork); waiter.catch(() => {});
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        blocked = (await db`select 1 from pg_stat_activity where pid<>pg_backend_pid() and query like ${`%${schema}.%`}
          and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0`).length > 0;
        if (!blocked) await delay(20);
      }
      assert(blocked, "Competing review operation must wait on the same job lock");
    } finally { release(); }
    await holder;
    assert.equal(await waiter, expected);
  }
  await race(async tx => { assert.equal(await register(tx, election, "wrun_synthetic_winner"), true); }, tx => register(tx, election, "wrun_synthetic_loser"), false);
  await race(async tx => { assert.equal(await cancel(tx, cancelFirst), "cancel_requested"); }, tx => finish(tx, cancelFirst), "canceled");
  await race(async tx => { assert.equal(await finish(tx, finishFirst), "completed"); }, tx => cancel(tx, finishFirst), "completed");
  await race(async tx => { assert.equal(await expireOrphan(tx, deadlineFirst), 1); }, tx => register(tx, deadlineFirst, "wrun_synthetic_expired"), false);
  assert.equal(await finish(db, deadlineFirst), "failed", "Expired unacknowledged delivery cannot publish late");
  await race(async tx => { assert.equal(await register(tx, registerFirst, "wrun_synthetic_registered"), true); }, tx => expireOrphan(tx, registerFirst), 0);
  await race(async tx => { assert.equal(await finish(tx, publishBeforeDeadline), "completed"); }, tx => expireOrphan(tx, publishBeforeDeadline), 0);
  const rows = await db`select job_id,body from ${db(`${schema}.saved_analyses`)} where workspace_id=${workspace}`;
  assert.equal(rows.length, 2); assert.deepEqual(new Set(rows.map(row => row.job_id)), new Set([finishFirst, publishBeforeDeadline]));
  assert(rows.every(row => row.body === "Synthetic body"));
  console.log("PASS: three real SQL connections; run election, both cancel/publication lock orderings, orphan deadline versus registration/publication");
}
