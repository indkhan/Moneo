import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import postgres from "postgres";

export async function checkSerialization(db, connection, schema, run, record) {
  const actor=randomUUID(), account=randomUUID(), merchant=randomUUID();
  const ids=Array.from({length:6},()=>randomUUID());
  const names=[`MNE014-${run.marker}-writer-a`,`MNE014-${run.marker}-writer-b`];
  const clients=names.map(application_name=>postgres(connection.toString(),{ssl:"require",max:1,connect_timeout:10,connection:{application_name,statement_timeout:"20000",lock_timeout:"3000",idle_in_transaction_session_timeout:"30000"},onnotice:()=>{}}));
  const [a,b]=clients;
  let release;
  let tasks=[];
  try {
    await db.begin(async tx=>{
      await tx`select set_config('statement_timeout','20000',true),set_config('lock_timeout','3000',true)`;
      await tx.unsafe(`insert into ${schema}.auth_users(id,email) values($1,$2)`,[actor,`mne014-serialize-${actor}@example.invalid`]);
      const [workspace]=await tx.unsafe(`select id from ${schema}.workspaces where owner_id=$1`,[actor]);
      await tx`select set_config('request.jwt.claim.sub', ${actor}, true)`;
      await tx.unsafe(`insert into ${schema}.accounts(id,workspace_id,name,currency_code) values($1,$2,'Serialized fixture','EUR')`,[account,workspace.id]);
      await tx.unsafe(`insert into ${schema}.merchants(id,workspace_id,name,normalized_name) values($1,$2,'Serialized merchant','serialized merchant')`,[merchant,workspace.id]);
      for(let i=0;i<6;i++) await tx.unsafe(`insert into ${schema}.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind,merchant_id) values($1,$2,$3,($4::date+make_interval(months=>$5))::date,'Owned serialized invoice',-9007199254740993,'EUR','posted','ordinary',$6)`,[ids[i],workspace.id,account,i<3?'2024-01-31':'2026-01-31',i%3,merchant]);
    });
    const sources=await db.unsafe(`select ${schema}.recurring_evidence_snapshot(t)||jsonb_build_object('version',t.version) as receipt from ${schema}.transactions t where id=any($1::uuid[]) order by posted_on,id`,[ids]);
    const receipts=sources.map(row=>row.receipt);
    const pids=[0,0];
    record({phase:'serialization_sessions',names,pids,maxConnections:3});
    async function bounded(tx,index) {
      const [session]=await tx`select pg_backend_pid() as pid, set_config('application_name', ${names[index]}, true), set_config('statement_timeout','20000',true), set_config('lock_timeout','3000',true), set_config('idle_in_transaction_session_timeout','30000',true)`;
      pids[index]=session.pid;
    }
    async function asActor(tx,index) { await bounded(tx,index); await tx`select set_config('request.jwt.claim.sub', ${actor}, true)`; await tx.unsafe('set local role authenticated');
      const [identity]=await tx`select current_user as role,auth.uid() as actor`;
      assert.equal(identity.role,'authenticated');assert.equal(identity.actor,actor);
    }
    async function review(tx,evidence) {return tx.unsafe(`select (${schema}.review_recurring_series_versions('confirmed',$1,'Serialized merchant','monthly','EUR',$2::jsonb,$3)).id`,[account,tx.json(evidence.map(({id,version})=>({id,version}))),evidence[0].id]);}
    async function observeBlocked() {
      for(let attempt=0;attempt<20;attempt++) {
        const [state]=await db`select wait_event_type, ${pids[0]} = any(pg_blocking_pids(pid)) as owned_blocker from pg_stat_activity where pid=${pids[1]} and application_name=${names[1]}`;
        if(attempt===0 || attempt===19) record({phase:'lock_probe',attempt,state});
        if(state?.wait_event_type==='Lock' && state.owned_blocker) {record({phase:'owned_lock_observed',blocker:pids[0],waiting:pids[1]});return;}
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      assert.fail('Expected owned concurrent lock was not observed');
    }
    // Different source rows, same account: account lock serializes active-overlap checks.
    let ready;
    const readyPromise=new Promise(resolve=>{ready=resolve;});
    const hold=new Promise(resolve=>{release=resolve;});
    const first=a.begin(async tx=>{await asActor(tx,0);await review(tx,receipts.slice(0,3));ready();await hold;});
    tasks=[first];
    await Promise.race([readyPromise,first.then(()=>assert.fail('Writer finished before readiness'))]);
    const second=b.begin(async tx=>{await asActor(tx,1);await review(tx,receipts.slice(3));});
    tasks.push(second);
    // Attach rejection handling immediately; the blocker is bounded by SQL timeouts.
    const settled=Promise.allSettled(tasks);
    await observeBlocked(); release();
    const result=await settled;
    assert.equal(result[0].status,'fulfilled');assert.equal(result[1].status,'rejected');assert.equal(result[1].reason.code,'22023');
    const [counts]=await db.unsafe(`select (select count(*)::int from ${schema}.financial_assumptions where account_id=$1 and enabled and confirmed and removed_at is null) as active,(select count(*)::int from ${schema}.recurring_series where account_id=$1) as series`,[account]);
    assert.deepEqual(counts,{active:1,series:1});
    // A concurrent source-version change must be rechecked AFTER its posting lock.
    let changed;
    const changedPromise=new Promise(resolve=>{changed=resolve;});
    const sourceHold=new Promise(resolve=>{release=resolve;});
    const correction=a.begin(async tx=>{await bounded(tx,0);await tx`select set_config('request.jwt.claim.sub', ${actor}, true)`;await tx.unsafe(`update ${schema}.transactions set version=version+1 where id=$1`,[ids[0]]);changed();await sourceHold;});
    tasks=[correction]; await Promise.race([changedPromise,correction.then(()=>assert.fail('Correction finished before readiness'))]);
    const stale=b.begin(async tx=>{await asActor(tx,1);await review(tx,receipts.slice(0,3));});tasks.push(stale);
    const sourceSettled=Promise.allSettled(tasks);
    await observeBlocked();release();
    const sourceResult=await sourceSettled;
    assert.equal(sourceResult[0].status,'fulfilled');assert.equal(sourceResult[1].status,'rejected');assert.equal(sourceResult[1].reason.code,'40001');
    const [ledger]=await db.unsafe(`select count(*)::int as sources, bool_and(amount_minor=-9007199254740993 and currency_code='EUR' and merchant_id=$1) as original_money from ${schema}.transactions where id=any($2::uuid[])`,[merchant,ids]);
    assert.deepEqual(ledger,{sources:6,original_money:true});
    record({phase:'serialization_pass',activeSchedules:1,overlapSqlstate:'22023',staleSqlstate:'40001',ledgerOriginalsPreserved:true});
  } finally {
    release?.(); const completed=await Promise.allSettled(tasks);
    record({phase:"writer_results",results:completed.map(result=>({status:result.status,code:result.reason?.code,message:result.reason?.message}))});
    const closures=await Promise.allSettled(clients.map(client=>client.end({timeout:5})));
    for(const closure of closures) assert.equal(closure.status,'fulfilled','Each writer pool must close');
    const remaining=await db`select pid from pg_stat_activity where application_name=any(${names})`;
    assert.equal(remaining.length,0,'Owned writer sessions must close');
    record({phase:'serialization_closed',remainingWriterSessions:0});
  }
}
