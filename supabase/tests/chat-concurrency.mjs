// Real concurrent database connections; synthetic workspace, targeted cleanup.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";

process.loadEnvFile(".env");
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const connection = new URL(process.env.SUPABASE_DB_URL);
assert(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`), "Configured project mismatch");
const db = postgres(connection.toString(), { ssl: "require", max: 3, connect_timeout: 10 });
const user = randomUUID(), account = randomUUID(), transaction = randomUUID(), conversation = randomUUID(), request = randomUUID();
let workspace;
async function authenticated(tx) {
  await tx`select set_config('request.jwt.claim.sub',${user},true)`;
  await tx.unsafe("set local role authenticated");
}
try {
  await db.begin(async tx => {
    await tx`insert into auth.users(id,email) values(${user},${`qa-${user}@example.invalid`})`;
    [{ id: workspace }] = await tx`select id from public.workspaces where owner_id=${user}`;
    await tx`insert into public.accounts(id,workspace_id,name,currency_code) values(${account},${workspace},'Synthetic concurrency','EUR')`;
    await tx`insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code)
      values(${transaction},${workspace},${account},'2026-10-01','Synthetic concurrency',-100,'EUR')`;
    await tx`insert into public.conversations(id,workspace_id,title) values(${conversation},${workspace},'Synthetic concurrency')`;
  });
  const command = `Set category of transaction ${transaction} to "Synthetic category"`;
  const claims = await Promise.all([0, 1].map(() => db.begin(async tx => {
    await authenticated(tx);
    return (await tx`select public.start_chat_request(${request},${conversation},${command},'{}'::jsonb) result`)[0].result;
  })));
  assert.deepEqual(claims.map(claim => claim.started).sort(), [false, true]);
  assert.equal((await db`select count(*)::integer count from public.messages where request_id=${request}`)[0].count, 1);

  let release, acquired;
  const locked = new Promise(resolve => { acquired = resolve; });
  const unlock = new Promise(resolve => { release = resolve; });
  const holder = db.begin(async tx => {
    await authenticated(tx);
    // A duplicate authenticated claim takes the same execution lock without direct UPDATE privilege.
    await tx`select public.start_chat_request(${request},${conversation},${command},'{}'::jsonb)`;
    acquired();
    await unlock;
  });
  // Observe an early lock-holder failure so cleanup still runs instead of an unhandled rejection.
  holder.catch(error => acquired(error));
  const lockError = await locked;
  if (lockError) throw lockError;
  const cancel = db.begin(async tx => {
    await authenticated(tx);
    return (await tx`select public.cancel_chat_request(${request}) status`)[0].status;
  });
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      const rows = await db`select 1 from pg_stat_activity where pid <> pg_backend_pid()
        and query like '%cancel_chat_request%' and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid)) > 0`;
      blocked = rows.length > 0;
      if (!blocked) await delay(20);
    }
    assert(blocked, "Cancellation must wait for the execution row lock on a different connection");
  } finally { release(); }
  await holder;
  assert.equal(await cancel, "canceled");
  await assert.rejects(db.begin(async tx => {
    await authenticated(tx);
    await tx`select public.chat_set_category(${request},${transaction},'Synthetic category')`;
  }), error => error.code === "57014");
  assert.equal(await db.begin(async tx => {
    await authenticated(tx);
    return (await tx`select public.finish_chat_request(${request},'completed','Late answer') status`)[0].status;
  }), "canceled");
  assert.equal((await db`select count(*)::integer count from public.correction_events where transaction_id=${transaction}`)[0].count, 0);
  assert.equal((await db`select count(*)::integer count from public.messages where reply_to=${request}`)[0].count, 0);
  console.log("PASS: separate authenticated connections claim once; cancellation waits for execution lock and prevents later corrections/replies");
} finally {
  await db.begin(async tx => {
    await tx`delete from public.correction_events where workspace_id=${workspace ?? null}`;
    await tx`delete from public.messages where workspace_id=${workspace ?? null}`;
    await tx`delete from public.chat_requests where workspace_id=${workspace ?? null}`;
    await tx`delete from public.conversations where workspace_id=${workspace ?? null}`;
    await tx`delete from public.transactions where id=${transaction} and workspace_id=${workspace ?? null}`;
    await tx`delete from public.categories where workspace_id=${workspace ?? null}`;
    await tx`delete from public.accounts where id=${account} and workspace_id=${workspace ?? null}`;
    await tx`delete from public.workspaces where id=${workspace ?? null} and owner_id=${user}`;
    await tx`delete from auth.users where id=${user}`;
  });
  assert.equal((await db`select 1 from auth.users where id=${user}`).length, 0, "Synthetic user cleanup must complete");
  await db.end();
}
