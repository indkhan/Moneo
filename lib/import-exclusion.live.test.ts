import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { expect, it } from "vitest";

it.skipIf(process.env.RUN_IMPORT_EXCLUSION_DB_TESTS !== "1")("preserves exclusions, progress, fencing and immutable identity in a rolled-back SQL transaction", async () => {
  process.loadEnvFile(".env");
  const endpoint = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!), connection = new URL(process.env.SUPABASE_DB_URL!);
  expect(connection.hostname === `db.${endpoint.hostname.split(".")[0]}.supabase.co` || connection.username.endsWith(`.${endpoint.hostname.split(".")[0]}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1, onnotice: () => {} });
  const rollback = new Error("Successful rollback");
  const actor = randomUUID();
  try {
    try { await db.begin(async tx => {
      // Test the deployed schema, never replay an applied migration in the fixture.
      const [applied] = await tx`select name,statements from supabase_migrations.schema_migrations where version='202610060002'`;
      expect(applied, "Deploy migration 202610060002 before running this live test").toBeDefined();
      expect(applied.name).toBe("import_row_exclusions");
      expect(applied.statements.join("\n").replaceAll("\r\n", "\n").trim(), "Deployed migration must match the checked-in SQL").toBe(
        readFileSync("supabase/migrations/202610060002_import_row_exclusions.sql", "utf8").replaceAll("\r\n", "\n").trim(),
      );
      const [reviewApplied] = await tx`select name,statements from supabase_migrations.schema_migrations where version='202610060007'`;
      expect(reviewApplied, "Deploy migration 202610060007 before running this live test").toBeDefined();
      expect(reviewApplied.name).toBe("normalized_import_review");
      expect(reviewApplied.statements.join("\n").replaceAll("\r\n", "\n").trim(), "Deployed review migration must match the checked-in SQL").toBe(
        readFileSync("supabase/migrations/202610060007_normalized_import_review.sql", "utf8").replaceAll("\r\n", "\n").trim(),
      );
      expect((await tx`select to_regprocedure('public.record_import_exclusion(uuid,uuid,integer,jsonb)') present`)[0].present).not.toBeNull();
      await tx`insert into auth.users(id,email) values(${actor},${`qa-${actor}@example.invalid`})`;
      const [{ id: workspace }] = await tx`select id from public.workspaces where owner_id=${actor}`;
      const imported = randomUUID(), source = randomUUID();
      const reason = "Statement footer, not a posting";
      const mapping = { rowContractVersion: "normalized-row-v1", rowDecisions: [{ rowNumber: 2, action: "exclude", reason }] };
      await tx`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping)
        values(${imported},${workspace},'synthetic.csv','synthetic',${imported},'queued',1,${tx.json(mapping)})`;
      const row = { sourceId: source, rowNumber: 2, originalRow: { Date: "", Description: "Footer", Amount: "bad" }, reason };
      const write = () => tx`select public.record_import_exclusion(${imported},${workspace},1,${tx.json(row)})`;
      await write(); await write();
      const rows = await tx`select original_row,status,review_reasons from public.source_transactions where import_id=${imported}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ original_row: row.originalRow, status: "rejected", review_reasons: ["excluded_by_review"] });
      expect((await tx`select rejected_rows,total_rows from public.imports where id=${imported}`)[0]).toMatchObject({ rejected_rows: 1, total_rows: 1 });
      expect((await tx`select count(*)::integer count from public.transaction_sources where source_transaction_id=${source}`)[0].count).toBe(0);
      await expect(tx.savepoint(sp => sp`select public.record_import_exclusion(${imported},${workspace},1,${sp.json({ ...row, originalRow: { ...row.originalRow, Amount: "altered" } })})`)).rejects.toMatchObject({ code: "22023" });
      await tx`update public.imports set status='canceled' where id=${imported}`;
      await expect(tx.savepoint(sp => sp`select public.record_import_exclusion(${imported},${workspace},1,${sp.json(row)})`)).rejects.toMatchObject({ code: "57014" });
      await tx`update public.imports set status='running',run_version=2 where id=${imported}`;
      await expect(tx.savepoint(sp => sp`select public.record_import_exclusion(${imported},${workspace},1,${sp.json(row)})`)).rejects.toMatchObject({ code: "57014" });
      expect((await tx`select has_function_privilege('authenticated','public.record_import_exclusion(uuid,uuid,integer,jsonb)','execute') allowed`)[0].allowed).toBe(false);
      expect((await tx`select public.finish_import_run(${imported},${workspace},2,null) status`)[0].status).toBe("completed");
      await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
      await tx`select public.undo_import(${imported},0,0)`;
      expect((await tx`select status from public.imports where id=${imported}`)[0].status).toBe("undone");
      expect((await tx`select original_row from public.source_transactions where id=${source}`)[0].original_row).toEqual(row.originalRow);
      const reviewedImport = randomUUID(), account = randomUUID(), routeSource = randomUUID(), neighbor = randomUUID(), overlap = randomUUID(), footer = randomUUID();
      const original = { Date: "bad", Description: "Original", Amount: "2", Currency: "USD", State: "unsupported", Type: "Transfer", Merchant: "Amazon", Category: "Original" };
      const reviewedMapping = { accountName: "Reviewed synthetic", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", currencyColumn: "Currency", statusColumn: "State", typeColumn: "Type", merchantColumn: "Merchant", categoryColumn: "Category", dateFormat: "iso", amountSign: "signed", numericConvention: "decimal-dot", rowContractVersion: "normalized-row-v1", rowDecisions: [
        { rowNumber: 2, action: "correct", values: { Description: "Unrelated neighbor correction" } },
        { rowNumber: 3, action: "correct", values: { Date: "2026-09-02", Description: "Reviewed refund", Currency: "EUR", State: "pending", Type: "Card refund", Merchant: "IKEA", Category: "Reviewed" } },
        { rowNumber: 4, action: "exclude", reason: "Statement footer" },
      ] };
      await tx`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping) values(${reviewedImport},${workspace},'synthetic-review.csv','synthetic',${reviewedImport},'queued',3,${tx.json(reviewedMapping)})`;
      await tx`select public.prepare_import_route(${reviewedImport},${workspace},1,${account},${routeSource},'Reviewed synthetic','EUR',3)`;
      const payload = { accountName: "Reviewed synthetic", transactionId: randomUUID(), balanceId: randomUUID(), rowNumber: 2, sourceId: neighbor, originalRow: { Description: "Neighbor" }, description: "Neighbor", postedOn: "2026-09-01", amountMinor: "100", currencyCode: "EUR", status: "posted", kind: "ordinary", reviewReasons: [], action: "new" };
      await tx`select public.ingest_import_row(${reviewedImport},${workspace},1,${account},${tx.json(payload)})`;
      await tx`select public.ingest_import_row(${reviewedImport},${workspace},1,${account},${tx.json({ ...payload, transactionId: null, sourceId: overlap, rowNumber: 3, originalRow: original, description: "Reviewed refund", postedOn: "2026-09-02", amountMinor: "200", status: "pending", kind: "refund", action: "review" })})`;
      await tx`select public.record_import_exclusion(${reviewedImport},${workspace},1,${tx.json({ sourceId: footer, rowNumber: 4, reason: "Statement footer", originalRow: { Description: "Footer" } })})`;
      await tx`select public.finish_import_run(${reviewedImport},${workspace},1,null)`;
      await tx`insert into public.merchants(id,workspace_id,name,normalized_name) values(${randomUUID()},${workspace},'IKEA','ikea')`;
      await tx`insert into public.categories(id,workspace_id,name) values(${randomUUID()},${workspace},'Reviewed')`;
      await tx`set local role authenticated`;
      await tx`select public.resolve_normalized_import_review(${overlap},'accept')`;
      await tx`select public.resolve_normalized_import_review(${overlap},'accept')`;
      await tx`reset role`;
      const accepted = await tx`select t.currency_code,t.status,t.kind,m.name merchant,c.name category from public.transactions t join public.transaction_sources l on l.transaction_id=t.id left join public.merchants m on m.id=t.merchant_id left join public.categories c on c.id=t.category_id where l.source_transaction_id=${overlap}`;
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({ currency_code: "EUR", status: "pending", kind: "refund", merchant: "IKEA", category: "Reviewed" });
      expect((await tx`select original_row from public.source_transactions where id=${overlap}`)[0].original_row).toEqual(original);
      expect((await tx`select new_rows,review_rows,rejected_rows from public.imports where id=${reviewedImport}`)[0]).toMatchObject({ new_rows: 2, review_rows: 0, rejected_rows: 1 });
      throw rollback;
    }); } catch (error) { if (error !== rollback) throw error; }
    expect(await db`select id from auth.users where id=${actor}`).toHaveLength(0);
    expect(await db`select id from public.workspaces where owner_id=${actor}`).toHaveLength(0);
  } finally { await db.end(); }
}, 30000);


it.skipIf(process.env.RUN_IMPORT_EXCLUSION_DB_TESTS !== "1")("preserves corrected/excluded originals, normalized acceptance and worker fencing in an authenticated disposable SQL replay", () => {
  const output = execFileSync(process.execPath, ["supabase/tests/run-import-review.mjs"], { encoding: "utf8", timeout: 60_000 });
  expect(output).toContain("PASS import-row-exclusions.sql");
  expect(output).toContain("PASS import-review.sql");
  expect(output).toContain("PASS exact disposable schema rollback and unchanged applied migration history");
}, 65_000);
