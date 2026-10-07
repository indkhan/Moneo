import {randomUUID} from "node:crypto";
import {readFileSync, unlinkSync, writeFileSync} from "node:fs";
import postgres from "postgres";
import {expect, it} from "vitest";
import {resolveReviewRequest} from "./review-request";

it.skipIf(process.env.RUN_INVESTIGATION_REQUEST_DB_TESTS !== "1")("elects only one synthesis caller when two database transactions overlap", async () => {
  process.loadEnvFile(".env");
  const endpoint = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!), connection = new URL(process.env.SUPABASE_DB_URL!);
  expect(connection.hostname === `db.${endpoint.hostname.split(".")[0]}.supabase.co` || connection.username.endsWith(`.${endpoint.hostname.split(".")[0]}`)).toBe(true);
  const db = postgres(connection.toString(), {ssl: "require", max: 2, connection: {application_name: "qa_mne019_reservation_race"}, onnotice: () => {}});
  const nonce = randomUUID(), schema = `qa_reservation_${nonce.replaceAll("-", "")}`, marker = `mne019-reservation:${nonce}`;
  const journal = `.qa/mne019-reservation-${nonce}.json`, job = randomUUID(), workspace = randomUUID();
  let created = false, journalWritten = false, contender: Promise<boolean> | undefined;
  let history: {version: string}[] | undefined;
  try {
    history = await db<{version: string}[]>`select version from supabase_migrations.schema_migrations order by version`;
    writeFileSync(journal, JSON.stringify({schema, marker, job, workspace, purpose: "owned private synthesis race", status: "prepared"}));
    journalWritten = true;
    const specification = resolveReviewRequest({version: 1, question: "Synthetic reservation race", budget: {maxQueries: 1}}, "2026-10-07");
    const progress = {version: 1, request: specification, startedAt: Date.now(), supportRecords: 0, queries: [], limitations: [], synthesisAttempted: true};
    await db.begin(async tx => {
      await tx.unsafe("set local lock_timeout='5s'; set local statement_timeout='15s'");
      await tx.unsafe(`create schema ${schema}; comment on schema ${schema} is '${marker}'; grant usage on schema ${schema} to service_role`);
      await tx.unsafe(`create table ${schema}.background_jobs (like public.background_jobs including all);
        alter table ${schema}.background_jobs drop column if exists review_request cascade, drop column if exists review_progress cascade;
        alter table ${schema}.background_jobs add column review_request jsonb, add column review_progress jsonb`);
      const migration = readFileSync("supabase/migrations/202610070016_bounded_financial_investigation.sql", "utf8");
      const functions = migration.slice(migration.indexOf("create function public.checkpoint_financial_investigation"), migration.indexOf("-- Only the current run can publish"));
      expect(functions).toContain("create function public.reserve_financial_investigation_synthesis");
      await tx.unsafe(["background_jobs", "checkpoint_financial_investigation", "reserve_financial_investigation_synthesis"]
        .reduce((sql, name) => sql.replaceAll(`public.${name}`, `${schema}.${name}`), functions));
      await tx.unsafe(`insert into ${schema}.background_jobs(id,workspace_id,kind,request_id,status,workflow_run_id,review_request)
        values($1,$2,'financial_review',$3,'running','owned-race',$4::jsonb)`, [job, workspace, randomUUID(), tx.json(specification)]);
    });
    created = true;
    const reserve = async (tx: postgres.TransactionSql) => (await tx.unsafe(`select ${schema}.reserve_financial_investigation_synthesis($1,$2,'owned-race',$3::jsonb) as accepted`, [job, workspace, tx.json(progress)]))[0].accepted as boolean;
    const first = await db.begin(async leader => {
      await leader.unsafe("set local lock_timeout='5s'; set local statement_timeout='15s'; set local role service_role");
      const [{pid: leaderPid}] = await leader`select pg_backend_pid() as pid`;
      const accepted = await reserve(leader);
      expect(accepted).toBe(true);
      let ready!: (pid: number) => void;
      const competingPid = new Promise<number>(resolve => {ready = resolve;});
      contender = db.begin(async other => {
        await other.unsafe("set local lock_timeout='5s'; set local statement_timeout='15s'; set local role service_role");
        const [{pid}] = await other`select pg_backend_pid() as pid`;
        ready(pid);
        return reserve(other);
      });
      void contender.catch(() => {});
      const pid = await competingPid;
      // Observe a real overlapping lock wait, rather than relying on a sleep or sequential calls.
      await expect.poll(async () => (await leader`select ${leaderPid}::integer = any(pg_blocking_pids(${pid}::integer)) as blocked`)[0].blocked,
        {timeout: 3000, interval: 50}).toBe(true);
      return accepted;
    });
    expect([first, await contender]).toEqual([true, false]);
    expect((await db.unsafe(`select review_progress->>'synthesisAttempted' as attempted from ${schema}.background_jobs where id=$1`, [job]))[0].attempted).toBe("true");
  } finally {
    await contender?.catch(() => {});
    try {
      if (created) {
        const [metadata] = await db`select obj_description(oid,'pg_namespace') as marker from pg_namespace where nspname=${schema}`;
        expect(metadata?.marker).toBe(marker);
        await db.unsafe(`drop schema ${schema} cascade`);
      }
      expect(await db`select schema_name from information_schema.schemata where schema_name=${schema}`).toHaveLength(0);
      if (history) expect(await db`select version from supabase_migrations.schema_migrations order by version`).toEqual(history);
      if (journalWritten) unlinkSync(journal);
    } finally {await db.end();}
  }
}, 30000);
