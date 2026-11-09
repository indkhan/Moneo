import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

// Stop pressed while the import worker is mid-batch: the worker already holds the import row and is about to insert rows,
// which needs a key lock on the workspace. Stop must wait for the batch and then finish, never deadlock with it.
process.loadEnvFile(".env");
const options = { max: 1, onnotice: () => {}, connection: { application_name: "import-stop-race", lock_timeout: "20s", statement_timeout: "30s" } };
const url = process.env.SUPABASE_DB_URL;
const db = postgres(url, options), worker = postgres(url, options), stop = postgres(url, options);
const actor = randomUUID(), imported = randomUUID(), account = randomUUID();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let workspace;
try {
  await db`insert into auth.users(id,email,raw_user_meta_data) values(${actor},${`qa-import-stop-${actor}@example.invalid`},'{"qa_test":"import-stop-race"}')`;
  [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${actor}`;
  await db`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows) values(${imported},${workspace},'race.csv',${`${workspace}/race.csv`},${imported},'running',1)`;
  const [{ pid: workerPid }] = await worker`select pg_backend_pid() pid`, [{ pid: stopPid }] = await stop`select pg_backend_pid() pid`;

  let locked, stopWaiting;
  const hasLock = new Promise(resolve => { locked = resolve; }), stopIsWaiting = new Promise(resolve => { stopWaiting = resolve; });
  const batch = worker.begin(async tx => {
    await tx`select public.lock_import_run(${imported},${workspace},1)`;
    locked();
    await stopIsWaiting;
    await tx`insert into public.accounts(id,workspace_id,name,currency_code) values(${account},${workspace},'Import stop race','EUR')`;
  });
  await hasLock;
  const stopped = stop.begin(async tx => {
    await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
    await tx.unsafe("set local role authenticated");
    return (await tx`select public.control_import(${imported},'cancel',${randomUUID()}) result`)[0].result;
  });
  let blocked = false;
  for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
    [{ blocked }] = await db`select ${workerPid}::integer=any(pg_blocking_pids(${stopPid}::integer)) blocked`;
    if (!blocked) await sleep(50);
  }
  assert(blocked, "Stop must wait for the batch that is running");
  stopWaiting();
  const [batchResult, stopResult] = await Promise.allSettled([batch, stopped]);
  assert.equal(batchResult.reason?.message, undefined, "The batch must finish");
  assert.equal(stopResult.reason?.message, undefined, "Stop must finish");
  assert.equal(stopResult.value.status, "canceled");
  assert.equal((await db`select id from public.accounts where id=${account}`).length, 1);
  console.log("PASS: Stop during a batch waits for it and then cancels, with no deadlock");
} finally {
  if (workspace) await db.begin(async tx => {
    await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
    await tx`delete from public.import_control_events where workspace_id=${workspace}`;
    await tx`select public.reset_workspace()`;
    await tx`delete from public.categories where workspace_id in (select id from public.workspaces where owner_id=${actor})`;
    await tx`delete from public.workspaces where owner_id=${actor}`;
  });
  await db`delete from auth.users where id=${actor} and raw_user_meta_data->>'qa_test'='import-stop-race'`;
  await Promise.allSettled([worker.end(), stop.end()]);
  await db.end();
}
