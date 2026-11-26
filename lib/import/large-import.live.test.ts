import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { expect, it } from "vitest";
import { batchDecisions, candidateRowsSchema } from "@/lib/import/batch";
import { stableId } from "@/lib/import/row";

const rows = 2500, batch = 250;

it.skipIf(process.env.RUN_LARGE_IMPORT_DB_TESTS !== "1")("keeps per-row work flat while one session imports thousands of rows into tables whose statistics predate the import", async () => {
  process.loadEnvFile(".env.qa");
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const actor = randomUUID();
  try {
    await db`insert into auth.users(id,email,raw_user_meta_data) values(${actor},${`qa-${actor}@example.invalid`},'{"qa_test":"large-import"}')`;
    const [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${actor}`;
    await db`vacuum analyze public.transactions, public.source_transactions, public.transaction_sources, public.balance_snapshots`;
    const importId = randomUUID(), accountId = stableId(`${workspace}:account:Large synthetic:EUR`);
    await db`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping)
      values(${importId},${workspace},'large.csv',${`${workspace}/large.csv`},${importId},'queued',${rows},'{"rowContractVersion":"normalized-row-v1"}'::jsonb)`;
    await db`select public.prepare_import_route(${importId},${workspace},1,${accountId},${stableId(`${workspace}:source:${accountId}`)},'Large synthetic','EUR',${rows})`;
    const staged = Array.from({ length: rows }, (_, i) => ({ accountId, excluded: false, row: {
      sourceId: stableId(`${importId}:row:${i + 2}`), balanceId: stableId(`${importId}:balance:${i + 2}`), accountName: "Large synthetic", rowNumber: i + 2,
      originalRow: { date: "2026-09-01", description: `Synthetic expense ${i + 1}`, amount: "-1.01", id: `large-${i + 1}` }, externalId: `large-${i + 1}`,
      reviewReasons: [], postedOn: "2026-09-01", description: `Synthetic expense ${i + 1}`, amountMinor: "-101", currencyCode: "EUR", status: "posted", kind: "ordinary" } }));
    const [imported] = await db`select mapping,route_accounts,source_id from public.imports where id=${importId}`;
    await db`select public.stage_import_rows(${importId},${workspace},1,${importId},${db.json(imported.mapping)},${db.json(imported.route_accounts)},${imported.source_id},${db.json(staged)})`;
    const blocksPerRow: number[] = [];
    for (let offset = 0; offset < rows; offset += batch) {
      const [{ result }] = await db`select public.import_batch_candidates(${importId},${workspace},1,${offset}) as result`;
      const decisions = batchDecisions(candidateRowsSchema.parse(result));
      const [{ "QUERY PLAN": [{ Plan: plan }] }] = await db.unsafe("explain (analyze,buffers,format json) select public.ingest_import_batch($1::uuid,$2::uuid,1,$3::integer,$4::text::jsonb)", [importId, workspace, offset, JSON.stringify(decisions)]);
      blocksPerRow.push((plan["Shared Hit Blocks"] + plan["Shared Read Blocks"]) / batch);
    }
    expect((await db`select public.finish_import_run(${importId},${workspace},1,null) as status`)[0].status).toBe("completed");
    const [kept] = await db`select count(*)::int as sources, count(*) filter (where s.original_row->>'id'='large-'||(s.row_number-1) and s.external_id=s.original_row->>'id')::int as exact,
      count(t.id)::int as transactions, sum(t.amount_minor)::text as total_minor
      from public.source_transactions s left join public.transaction_sources l on l.source_transaction_id=s.id left join public.transactions t on t.id=l.transaction_id where s.import_id=${importId}`;
    expect(kept).toEqual({ sources: rows, exact: rows, transactions: rows, total_minor: String(-101n * BigInt(rows)) });
    const [early, last] = [blocksPerRow[1] ?? 0, blocksPerRow.at(-1) ?? 0];
    expect(last, `A batch read ${last.toFixed(0)} buffer blocks per row after ${rows - batch} rows against ${early.toFixed(0)} after ${batch}: a per-row lookup is scanning the rows this import already loaded, so its plan was built for the tables before the import grew them. Keep planner statistics current during the import (refresh_import_statistics).`).toBeLessThanOrEqual(2 * early);
  } finally {
    await db.begin(async tx => {
      const [owned] = await tx`select id from public.workspaces where owner_id=${actor}`;
      if (owned) {
        await tx`delete from public.transaction_sources where source_transaction_id in(select id from public.source_transactions where workspace_id=${owned.id})`;
        for (const table of ["saved_analyses", "background_jobs", "import_control_events", "balance_snapshots", "transactions", "source_transactions", "import_staging", "imports", "data_sources", "accounts", "merchants", "categories"]) await tx`delete from ${tx(`public.${table}`)} where workspace_id=${owned.id}`;
        await tx`delete from public.workspaces where id=${owned.id}`;
      }
      await tx`delete from auth.users where id=${actor}`;
    });
    await db.end();
  }
}, 60_000);
