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
    try {await db.begin(async tx => {
      await tx.unsafe("set local lock_timeout='5s'; set local statement_timeout='15s'");
      await tx.unsafe(`create schema ${schema}; grant usage on schema ${schema} to authenticated,service_role`);
      await tx.unsafe(`create table ${schema}.background_jobs (like public.background_jobs including all)`);
      const migration = readFileSync("supabase/migrations/202610070016_bounded_financial_investigation.sql", "utf8").replaceAll("public.background_jobs", `${schema}.background_jobs`)
        .replaceAll("public.start_financial_investigation", `${schema}.start_financial_investigation`)
        .replaceAll("public.checkpoint_financial_investigation", `${schema}.checkpoint_financial_investigation`)
        .replaceAll("public.freeze_financial_investigation_request", `${schema}.freeze_financial_investigation_request`);
      await tx.unsafe(migration);
      await tx`insert into auth.users(id,email) values(${owner},${`qa-${owner}@example.invalid`}),(${other},${`qa-${other}@example.invalid`})`;
      const [{id: workspace}] = await tx`select id from public.workspaces where owner_id=${owner}`;
      const specification = resolveReviewRequest({version: 1, question: "Review September subscriptions", budget: {maxQueries: 2}}, "2026-10-07");
      const requestId = randomUUID();
      await tx`select set_config('request.jwt.claim.sub',${owner},true)`;
      await tx.unsafe("set local role authenticated");
      const claim = async (spec = specification) => (await tx.unsafe(`select ${schema}.start_financial_investigation($1,$2::jsonb,null) as receipt`, [requestId, tx.json(spec)]))[0].receipt;
      const first = await claim();
      expect(first.started).toBe(true);
      expect((await claim()).jobId).toBe(first.jobId);
      await expect(tx.savepoint(async sp => sp.unsafe(`select ${schema}.start_financial_investigation($1,$2::jsonb,null)`, [requestId, sp.json({...specification, focus: "Changed"})]))).rejects.toMatchObject({code: "22023"});
      await expect(tx.savepoint(async sp => sp.unsafe(`select ${schema}.start_financial_investigation($1,$2::jsonb,null)`, [randomUUID(), sp.json({...specification, budget: {...specification.budget, maxQueries: 500}})]))).rejects.toMatchObject({code: "22023"});
      await expect(tx.savepoint(async sp => sp.unsafe(`select ${schema}.checkpoint_financial_investigation($1,$2,'run',$3::jsonb)`, [first.jobId, workspace, sp.json({})]))).rejects.toMatchObject({code: "42501"});
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
      await tx.unsafe(`update ${schema}.background_jobs set cancel_requested=true where id=$1`, [first.jobId]);
      await tx.unsafe("set local role service_role");
      expect(await checkpoint()).toBe(false);
      throw rollback;
    });} catch (error) {if (error !== rollback) throw error;}
    expect(await db`select id from auth.users where id in (${owner},${other})`).toHaveLength(0);
    expect(await db`select schema_name from information_schema.schemata where schema_name=${schema}`).toHaveLength(0);
  } finally {await db.end();}
}, 30000);
