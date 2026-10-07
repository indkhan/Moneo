import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildSourceCoverage, loadSourceCoverageMetadata, sourceCoverageNeedsReview } from "../../lib/finance/source-coverage.ts";

// Synthetic normalized ingestion, actual scoped SQL projections, and the shared reader.
// Caller owns the disposable schema transaction; this helper never commits.
export async function sourceCoverageReaderProof(tx, schema) {
  const actor = randomUUID(), account = randomUUID(), initial = randomUUID(), overlap = randomUUID(), source = randomUUID();
  await tx.unsafe(`insert into ${schema}.auth_users(id,email) values($1,$2)`, [actor, `qa-${actor}@example.invalid`]);
  const [{ id: workspace }] = await tx.unsafe(`select id from ${schema}.workspaces where owner_id=$1`, [actor]);
  await tx.unsafe(`select set_config('request.jwt.claim.sub',$1,true)`, [actor]);
  for (const imported of [initial, overlap]) {
    await tx.unsafe(`insert into ${schema}.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping) values($1,$2,'synthetic.csv',$3,($1::uuid)::text,'queued',1,'{"accountName":"Synthetic coverage","currencyCode":"EUR","rowContractVersion":"normalized-row-v1"}')`, [imported, workspace, `${workspace}/synthetic.csv`]);
    await tx.unsafe(`select ${schema}.prepare_import_route($1,$2,1,$3,$4,'Synthetic coverage','EUR',1)`, [imported, workspace, account, randomUUID()]);
    const payload = { accountName: "Synthetic coverage", sourceId: imported === initial ? randomUUID() : source, transactionId: imported === initial ? randomUUID() : null, balanceId: randomUUID(), rowNumber: 2, originalRow: { Description: "Synthetic overlap", Amount: "-10.00" }, postedOn: "2026-09-02", description: "Synthetic overlap", amountMinor: "-1000", currencyCode: "EUR", status: "posted", kind: "ordinary", reviewReasons: [], action: imported === initial ? "new" : "review" };
    await tx.unsafe(`select ${schema}.ingest_import_row($1,$2,1,$3,$4::jsonb)`, [imported, workspace, account, tx.json(payload)]);
    await tx.unsafe(`select ${schema}.finish_import_run($1,$2,1,null)`, [imported, workspace]);
  }
  const db = { from(table) {
    assert.ok(["imports", "source_transactions"].includes(table));
    let scopedWorkspace;
    return { select(columns) {
      assert.equal(columns.includes("original_row"), false);
      return this;
    }, eq(field, value) { assert.equal(field, "workspace_id"); scopedWorkspace = value; return this; }, order(field) { assert.equal(field, "id"); return this; }, async range(from, to) {
      assert.equal(scopedWorkspace, workspace);
      const columns = table === "imports" ? "id,status,total_rows" : "import_id,status,review_reasons,normalized_row->'row'->>'postedOn' as posted_on,normalized_row->'row'->>'currencyCode' as currency_code,normalized_row->>'accountId' as account_id,normalized_row->'resolution'->>'accountId' as resolved_account_id";
      return { data: await tx.unsafe(`select ${columns} from ${schema}.${table} where workspace_id=$1 order by id offset $2 limit $3`, [scopedWorkspace, from, to - from + 1]), error: null };
    } };
  } };
  async function evidence() {
    const metadata = await loadSourceCoverageMetadata(db, workspace, true);
    const rows = await tx.unsafe(`select account_id,posted_on::text,currency_code,status,kind,review_reasons from ${schema}.effective_transactions where workspace_id=$1`, [workspace]);
    const [{ amount }] = await tx.unsafe(`select sum(amount_minor)::text as amount from ${schema}.effective_transactions where workspace_id=$1`, [workspace]);
    return { coverage: buildSourceCoverage({ from: "2026-09-01", to: "2026-09-30", currencyCode: "EUR" }, rows, metadata.imports, metadata.sources), amount };
  }
  assert.equal((await evidence()).amount, "-1000");
  assert.equal((await evidence()).coverage.unresolvedSourceRows, 1);
  await tx.unsafe("savepoint duplicate_resolution");
  await tx.unsafe(`select ${schema}.resolve_normalized_import_review($1,'reject')`, [source]);
  const duplicate = await evidence();
  assert.equal(duplicate.amount, "-1000");
  assert.equal(duplicate.coverage.rejectedSourceRows, 1);
  assert.equal(duplicate.coverage.unresolvedSourceRows, 0);
  assert.equal(sourceCoverageNeedsReview(duplicate.coverage), false);
  await tx.unsafe("rollback to savepoint duplicate_resolution");
  await tx.unsafe(`select ${schema}.resolve_normalized_import_review($1,'accept')`, [source]);
  const accepted = await evidence();
  assert.equal(accepted.amount, "-2000");
  assert.equal(accepted.coverage.acceptedSourceRows, 2);
  assert.equal(accepted.coverage.unresolvedSourceRows, 0);
  assert.equal(sourceCoverageNeedsReview(accepted.coverage), false);
  assert.equal(accepted.coverage.totalsAreBounds, false);
  const [{ unchanged }] = await tx.unsafe(`select original_row='{"Description":"Synthetic overlap","Amount":"-10.00"}'::jsonb as unchanged from ${schema}.source_transactions where id=$1`, [source]);
  assert.equal(unchanged, true);
  console.log("PASS normalized SQL reader: unresolved -1000; duplicate reject -1000; genuine accept -2000; retained source; no bounds");
}
