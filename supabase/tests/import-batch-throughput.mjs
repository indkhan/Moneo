// Real database budgets in one rollback-only complete private application
// replay. Serialize with auth/browser gates: this managed database acquires
// real auth-table locks even for CREATE POLICY on a private dummy table.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import postgres from "postgres";

process.loadEnvFile(".env");
const connection = new URL(process.env.SUPABASE_DB_URL), project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
assert(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`));
const db = postgres(connection.toString(), { ssl: "require", max: 1, onnotice: () => {}, connection: { application_name: "mne015-throughput", lock_timeout: "10s", statement_timeout: "120s" } });
const schema = `mne015_throughput_qa_${randomUUID().replaceAll("-", "")}`;
const isolated = text => text.replace(/\bpublic\./g, `${schema}.`).replace(/\bauth\.users\b/g, `${schema}.auth_users`);
const history = await db`select version from supabase_migrations.schema_migrations order by version`;
const results = [], plans = {}, rollback = new Error("Successful owned throughput rollback");
let managedAuthRelationLocks;
try {
  await db.begin(async tx => {
    await tx.unsafe(`create schema ${schema}; create table ${schema}.auth_users(id uuid primary key,email text); grant usage on schema ${schema} to authenticated,service_role`);
    for (const file of readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort()) {
      let text = readFileSync(`supabase/migrations/${file}`, "utf8");
      if (file.endsWith("_initial.sql")) text = text.slice(0, text.indexOf("insert into storage.buckets")).replace(/^create extension if not exists pgcrypto;\s*/i, "");
      await tx.unsafe(isolated(text));
    }
    managedAuthRelationLocks = await tx`select l.mode,count(*)::integer as count from pg_locks l join pg_class c on c.oid=l.relation join pg_namespace n on n.oid=c.relnamespace where l.pid=pg_backend_pid() and n.nspname='auth' group by l.mode`;
    const app = (strings, ...values) => tx.unsafe(isolated(strings.reduce((text, part, index) => text + part + (index < values.length ? `$${index + 1}` : ""), "")), values);
    const actor = randomUUID();
    await app`insert into auth.users(id,email) values(${actor},${`qa-batch-throughput-${actor}@example.invalid`})`;
    const [{ id: workspace }] = await app`select id from public.workspaces where owner_id=${actor}`;
    for (const total of [100, 1000, 10000]) {
      const imported = randomUUID(), account = randomUUID(), source = randomUUID();
      const csv = ["Date,Description,Amount", ...Array.from({ length: total }, (_, i) => `2026-10-01,Synthetic ${i},-1.01`)].join("\n");
      const hash = createHash("sha256").update(csv).digest("hex"), accountName = `Bounded ${total}`;
      await app`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping) values(${imported},${workspace},'synthetic.csv',${workspace + "/synthetic.csv"},${hash},'queued',${total},'{"rowContractVersion":"normalized-row-v1"}'::jsonb)`;
      await app`select public.prepare_import_route(${imported},${workspace},1,${account},${source},${accountName},'EUR',${total})`;
      const [{ rows }] = await app`select jsonb_agg(jsonb_build_object('accountId',${account}::uuid,'excluded',false,'row',jsonb_build_object('accountName',${accountName}::text,'sourceId',public.stable_import_uuid(${imported}::text||':row:'||n),'balanceId',public.stable_import_uuid(${imported}::text||':balance:'||n),'rowNumber',n,'originalRow',jsonb_build_object('Amount','-1.01','Description','Synthetic '||(n-2)),'postedOn','2026-10-01','description','Synthetic '||(n-2),'amountMinor','-101','currencyCode','EUR','status','posted','kind','ordinary','reviewReasons','[]'::jsonb))) as rows from generate_series(2,${total + 1}) n`;
      const started = performance.now(), rssBefore = process.memoryUsage().rss;
      await tx.unsafe(`select ${schema}.stage_import_rows($1::uuid,$2::uuid,1,$3::text,$4::jsonb)`, [imported, workspace, hash, rows]);
      let calls = 1, maxCandidatesBytes = 0;
      for (let offset = 0; offset < total; offset += 250) {
        const [{ result: candidates }] = await tx.unsafe(`select ${schema}.import_batch_candidates($1::uuid,$2::uuid,1,$3::integer) as result`, [imported, workspace, offset]); calls++;
        assert(candidates.length <= 250); assert(candidates.every(row => row.candidates.length === 0));
        maxCandidatesBytes = Math.max(maxCandidatesBytes, Buffer.byteLength(JSON.stringify(candidates)));
        await tx.unsafe(`select ${schema}.ingest_import_batch($1::uuid,$2::uuid,1,$3::integer,$4::jsonb)`, [imported, workspace, offset, candidates.map(row => ({ rowNumber: row.rowNumber, action: "new" }))]); calls++;
      }
      const [{ count, total_minor: amount }] = await app`select count(*)::integer count,sum(amount_minor)::text total_minor from public.transactions where workspace_id=${workspace} and account_id=${account}`;
      assert.equal(count, total); assert.equal(amount, String(-101n * BigInt(total)));
      const [{ originals }] = await app`select count(*)::integer originals from public.source_transactions where import_id=${imported} and original_row->>'Amount'='-1.01'`;
      assert.equal(originals, total);
      results.push({ rows: total, stagingAndBatchRpcCalls: calls, stagedUtf8Bytes: Buffer.byteLength(JSON.stringify(rows)), maxCandidatesUtf8Bytes: maxCandidatesBytes, databaseFixtureMs: Math.round(performance.now() - started), clientRssDeltaBytes: process.memoryUsage().rss - rssBefore });
      console.log(`PASS: ${total} rows, ${calls} staging/batch RPC calls, exact ${amount} minor-unit total and ${originals} original source observations`);
      if (total === 10000) {
        await tx.unsafe(`analyze ${schema}.transactions; analyze ${schema}.source_transactions; analyze ${schema}.transaction_sources`);
        const fingerprint = await app`explain (analyze,buffers,format json) select id,status from public.transactions where workspace_id=${workspace} and account_id=${account} and posted_on='2026-10-01' and amount_minor=-101 and currency_code='EUR' and description='Synthetic 42'`;
        const linked = await app`explain (analyze,buffers,format json) select transaction_id from public.transaction_sources where transaction_id=(select id from public.transactions where workspace_id=${workspace} and account_id=${account} and description='Synthetic 42')`;
        // One synthetic stable external ID makes the old exact external lookup
        // selective, including all original source/link evidence.
        await app`update public.source_transactions set external_id='synthetic-stable-external' where import_id=${imported} and row_number=2`;
        await tx.unsafe(`analyze ${schema}.source_transactions`);
        const external = await app`explain (analyze,buffers,format json) select id from public.source_transactions where workspace_id=${workspace} and external_id='synthetic-stable-external' and import_id<>${randomUUID()}`;
        for (const [name, rows] of Object.entries({ transactions_import_description_idx: fingerprint, transaction_sources_transaction_idx: linked, source_transactions_import_external_idx: external })) {
          const plan = rows[0]["QUERY PLAN"]; assert(JSON.stringify(plan).includes(name), `Natural planner must use the proposed ${name} for its unchanged equality predicate`); plans[name] = plan;
        }
        console.log("PASS: natural EXPLAIN ANALYZE uses all three proposed indexes for existing fingerprint, canonical-source and external-ID equality predicates");
      }
    }
    throw rollback;
  });
} catch (error) { if (error !== rollback) throw error; }
finally {
  assert.equal((await db`select 1 from pg_namespace where nspname=${schema}`).length, 0);
  assert.deepEqual(await db`select version from supabase_migrations.schema_migrations order by version`, history);
  await db.end();
}
mkdirSync(".qa", { recursive: true });
writeFileSync(".qa/mne015-throughput.json", JSON.stringify({ scope: "Fresh complete private application schema; direct SQL RPC execution in one serialized rollback transaction; managed auth-table locks during policy DDL; not hosted Workflow end-to-end latency or peak memory", results, plans, managedAuthRelationLocks, schemaRemoved: true, migrationHistoryUnchanged: true }, null, 2));
console.log("PASS: candidate schema, all synthetic DML and migration history rollback verified");
