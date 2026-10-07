import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import postgres from "postgres";
import {expect, it} from "vitest";
import {resolveReviewRequest} from "./review-request";

it.skipIf(process.env.RUN_INVESTIGATION_REQUEST_DB_TESTS !== "1")("freezes owned request identity and fences durable budgets to the elected running worker", async () => {
  process.loadEnvFile(".env");
  const endpoint = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!), connection = new URL(process.env.SUPABASE_DB_URL!);
  expect(connection.hostname === `db.${endpoint.hostname.split(".")[0]}.supabase.co` || connection.username.endsWith(`.${endpoint.hostname.split(".")[0]}`)).toBe(true);
  const db = postgres(connection.toString(), {ssl: "require", max: 1, connection: {application_name: "qa_mne019_request_gate"}, onnotice: () => {}});
  const schema = `qa_request_${randomUUID().replaceAll("-", "")}`, owner = randomUUID(), other = randomUUID();
  const rollback = new Error("Fixture rollback");
  try {
    const history = await db`select version from supabase_migrations.schema_migrations order by version`;
    try {await db.begin(async tx => {
      await tx.unsafe("set local lock_timeout='5s'; set local statement_timeout='15s'");
      await tx.unsafe(`create schema ${schema}; grant usage on schema ${schema} to authenticated,service_role`);
      await tx.unsafe(`create table ${schema}.background_jobs (like public.background_jobs including all)`);
      await tx.unsafe(`create table ${schema}.saved_analyses (like public.saved_analyses including all); create table ${schema}.summary_runs (like public.summary_runs including all);
        create table ${schema}.financial_evidence_receipts(id uuid primary key,workspace_id uuid not null,scopes text[] not null)`);
      const privateSql = (sql: string) => ["background_jobs", "saved_analyses", "summary_runs", "financial_evidence_receipts", "start_financial_investigation", "checkpoint_financial_investigation", "freeze_financial_investigation_request", "reserve_financial_investigation_synthesis", "finish_financial_investigation", "finish_financial_review"]
        .reduce((text, name) => text.replaceAll(`public.${name}`, `${schema}.${name}`), sql);
      await tx.unsafe(privateSql(readFileSync("supabase/migrations/202610060011_source_coverage_review_permission.sql", "utf8")));
      await tx.unsafe(privateSql(readFileSync("supabase/migrations/202610070016_bounded_financial_investigation.sql", "utf8")));
      await tx`insert into auth.users(id,email) values(${owner},${`qa-${owner}@example.invalid`}),(${other},${`qa-${other}@example.invalid`})`;
      const [{id: workspace}] = await tx`select id from public.workspaces where owner_id=${owner}`;
      const specification = resolveReviewRequest({version: 1, question: "Review September subscriptions", context: {view: "transactions", category: "subscriptions"}, allowedScopes: ["accounts", "transactions", "imports"], budget: {maxQueries: 2}}, "2026-10-07");
      const requestId = randomUUID();
      await tx`select set_config('request.jwt.claim.sub',${owner},true)`;
      await tx.unsafe("set local role authenticated");
      const claim = async (spec = specification) => (await tx.unsafe(`select ${schema}.start_financial_investigation($1,$2::jsonb,null) as receipt`, [requestId, tx.json(spec)]))[0].receipt;
      const first = await claim();
      expect(first.started).toBe(true);
      expect((await claim()).jobId).toBe(first.jobId);
      await expect(tx.savepoint(async sp => sp.unsafe(`select ${schema}.start_financial_investigation($1,$2::jsonb,null)`, [requestId, sp.json({...specification, focus: "Changed"})]))).rejects.toMatchObject({code: "22023"});
      await expect(tx.savepoint(async sp => sp.unsafe(`select ${schema}.start_financial_investigation($1,$2::jsonb,null)`, [randomUUID(), sp.json({...specification, budget: {...specification.budget, maxQueries: 500}})]))).rejects.toMatchObject({code: "22023"});
      await expect(tx.savepoint(async sp => sp.unsafe(`select ${schema}.start_financial_investigation($1,$2::jsonb,null)`, [randomUUID(), sp.json({...specification, allowedScopes: ["imports"]})]))).rejects.toMatchObject({code: "22023"});
      await tx.unsafe("reset role");
      await tx`insert into public.workspace_settings(workspace_id,ai_data_scopes) values(${workspace},array['accounts','transactions','planning'])
        on conflict(workspace_id) do update set ai_data_scopes=excluded.ai_data_scopes`;
      await tx.unsafe("set local role authenticated");
      await expect(tx.savepoint(async sp => sp.unsafe(`select ${schema}.start_financial_investigation($1,$2::jsonb,null)`, [randomUUID(), sp.json(specification)]))).rejects.toMatchObject({code: "42501"});
      await tx.unsafe("reset role");
      await tx`update public.workspace_settings set ai_data_scopes=array['accounts','transactions','planning','imports'] where workspace_id=${workspace}`;
      await tx.unsafe("set local role authenticated");
      await expect(tx.savepoint(async sp => sp.unsafe(`select ${schema}.checkpoint_financial_investigation($1,$2,'run',$3::jsonb)`, [first.jobId, workspace, sp.json({})]))).rejects.toMatchObject({code: "42501"});
      await expect(tx.savepoint(async sp => sp.unsafe(`select ${schema}.reserve_financial_investigation_synthesis($1,$2,'run',$3::jsonb)`, [first.jobId, workspace, sp.json({})]))).rejects.toMatchObject({code: "42501"});
      await tx`select set_config('request.jwt.claim.sub',${other},true)`;
      expect((await claim()).jobId).not.toBe(first.jobId);
      await tx.unsafe("reset role");
      await tx.unsafe(`update ${schema}.background_jobs set workflow_run_id='run',status='running' where id=$1`, [first.jobId]);
      await tx.unsafe("set local role service_role");
      const progress = {version: 1, request: specification, startedAt: Date.now(), supportRecords: 0, queries: [{query: specification.query, status: "reading"}], limitations: []};
      const checkpoint = async (run = "run", value = progress) => (await tx.unsafe(`select ${schema}.checkpoint_financial_investigation($1,$2,$3,$4::jsonb) as accepted`, [first.jobId, workspace, run, tx.json(value)]))[0].accepted;
      expect(await checkpoint("foreign-run")).toBe(false);
      expect(await checkpoint()).toBe(true);
      await expect(tx.savepoint(async sp => sp.unsafe(`select ${schema}.checkpoint_financial_investigation($1,$2,'run',$3::jsonb)`, [first.jobId, workspace, sp.json({...progress, queries: []})]))).rejects.toMatchObject({code: "22023"});
      await tx.unsafe("reset role");
      await expect(tx.savepoint(async sp => sp.unsafe(`update ${schema}.background_jobs set review_request=$1::jsonb where id=$2`, [sp.json({...specification, question: "Changed"}), first.jobId]))).rejects.toMatchObject({code: "55000"});
      const receipt = randomUUID();
      await tx.unsafe(`insert into ${schema}.financial_evidence_receipts values($1,$2,array['accounts','transactions','imports'])`, [receipt, workspace]);
      await tx.unsafe("set local role service_role");
      const completed = {...progress, queries: [{query: specification.query, status: "completed", receiptId: receipt}], synthesisAttempted: true};
      const reserve = async (run = "run") => (await tx.unsafe(`select ${schema}.reserve_financial_investigation_synthesis($1,$2,$3,$4::jsonb) as accepted`, [first.jobId, workspace, run, tx.json(completed)]))[0].accepted;
      expect(await reserve("foreign-run")).toBe(false);
      expect(await reserve()).toBe(true);
      expect(await reserve()).toBe(false);
      await expect(tx.savepoint(async sp => sp.unsafe(`select ${schema}.checkpoint_financial_investigation($1,$2,'run',$3::jsonb)`, [first.jobId, workspace, sp.json({...completed, synthesisAttempted: false})]))).rejects.toMatchObject({code: "22023"});
      const evidence = {reviewInvestigation: {request: specification, progress: completed}, verification: {receiptIds: [receipt]}, planning: {unavailable: "Not included"}, sourceCoverage: {importStatuses: null}};
      const finish = async (run = "run", value = evidence) => (await tx.unsafe(`select ${schema}.finish_financial_investigation($1,$2,$3,'Review','Supported review',$4::jsonb,false) as status`, [first.jobId, workspace, run, tx.json(value)]))[0].status;
      expect(await finish("foreign-run")).toBe("canceled");
      await expect(tx.savepoint(async sp => sp.unsafe(`select ${schema}.finish_financial_investigation($1,$2,'run','Review','Supported review',$3::jsonb,false)`, [first.jobId, workspace, sp.json({...evidence, verification: {receiptIds: []}})]))).rejects.toMatchObject({code: "22023"});
      await tx.unsafe("reset role");
      await tx`insert into public.workspace_settings(workspace_id,ai_data_scopes) values(${workspace},array['accounts','transactions','planning'])
        on conflict(workspace_id) do update set ai_data_scopes=excluded.ai_data_scopes`;
      await tx.unsafe("set local role service_role");
      expect(await finish()).toBe("canceled");
      await tx.unsafe("reset role");
      expect(await tx.unsafe(`select id from ${schema}.saved_analyses where job_id=$1`, [first.jobId])).toHaveLength(0);
      await tx`update public.workspace_settings set ai_data_scopes=array['accounts','transactions','planning','imports'] where workspace_id=${workspace}`;
      await tx.unsafe(`update ${schema}.background_jobs set status='running',cancel_requested=false where id=$1`, [first.jobId]);
      await tx.unsafe("set local role service_role");
      expect(await finish()).toBe("completed");
      expect(await finish()).toBe("completed");
      await tx.unsafe("reset role");
      expect(await tx.unsafe(`select body from ${schema}.saved_analyses where job_id=$1`, [first.jobId])).toEqual([{body: "Supported review"}]);
      await tx.unsafe(`update ${schema}.background_jobs set cancel_requested=true where id=$1`, [first.jobId]);
      await tx.unsafe("set local role service_role");
      expect(await checkpoint()).toBe(false);
      throw rollback;
    });} catch (error) {if (error !== rollback) throw error;}
    expect(await db`select id from auth.users where id in (${owner},${other})`).toHaveLength(0);
    expect(await db`select schema_name from information_schema.schemata where schema_name=${schema}`).toHaveLength(0);
    expect(await db`select version from supabase_migrations.schema_migrations order by version`).toEqual(history);
  } finally {await db.end();}
}, 30000);
