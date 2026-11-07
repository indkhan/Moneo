import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { expect, it } from "vitest";

it.skipIf(process.env.RUN_IMPORT_ROW_UNDO_DB_TESTS !== "1")("reopens exact decisions, retains receipts and refuses dependencies in a rolled-back migration", async () => {
  process.loadEnvFile(".env");
  const connection = new URL(process.env.SUPABASE_DB_URL!);
  const db = postgres(connection.toString(), { max: 1, onnotice: () => {} });
  const rollback = new Error("Successful rollback");
  try {
    await expect(db.begin(async tx => {
      const migration = readFileSync("supabase/migrations/202611040004_import_row_decision_undo.sql", "utf8").replaceAll("\r\n", "\n").trim();
      const [present] = await tx`select to_regclass('public.import_row_decisions') present`;
      if (!present.present) await tx.unsafe(migration);
      else {
        const [applied] = await tx`select statements from supabase_migrations.schema_migrations where version='202611040004'`;
        expect(applied, "Existing row decision schema must be tracked by its migration").toBeDefined();
        // The CLI ledger splits statements, dropping their semicolons and blank lines.
        const comparable = (sql: string) => sql.replace(/[;\s]/g, "");
        expect(comparable(applied.statements.join("\n"))).toBe(comparable(migration));
      }
      await tx.unsafe(readFileSync("supabase/migrations/202611040005_import_row_undo_correction_history.sql", "utf8"));
      const actor = randomUUID(), other = randomUUID(), account = randomUUID(), imported = randomUUID(), source = randomUUID(), balance = randomUUID();
      await tx`insert into auth.users(id,email) values(${actor},${`qa-${actor}@example.invalid`}),(${other},${`qa-${other}@example.invalid`})`;
      const [{ id: workspace }] = await tx`select id from public.workspaces where owner_id=${actor}`;
      await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
      await tx`insert into public.accounts(id,workspace_id,name,currency_code) values(${account},${workspace},'Undo fixture','EUR')`;
      await tx`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,review_rows,mapping,route_accounts)
        values(${imported},${workspace},'undo.csv','synthetic',${imported},'completed',1,1,'{}',${tx.json({ route: account })})`;
      const row = { sourceId: source, rowNumber: 2, originalRow: { Description: "Original" }, description: "Reviewed", postedOn: "2026-11-01", amountMinor: "-1200", currencyCode: "EUR", status: "posted", kind: "ordinary", reviewReasons: [], balanceId: balance, balanceMinor: "8800", balanceAsOf: "2026-11-01T12:00:00Z" };
      await tx`insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row,status,normalized_row)
        values(${source},${workspace},${imported},2,${tx.json(row.originalRow)},'review',${tx.json({ row, mapping: {}, routeKey: "route", accountId: account })})`;
      const accept = () => tx`select public.resolve_normalized_import_review(${source},'accept')`;
      const reject = () => tx`select public.resolve_normalized_import_review(${source},'reject')`;
      const current = async () => (await tx`select * from public.import_row_decisions where source_id=${source} and undone_at is null`)[0];
      await accept(); await accept();
      const first = await current();
      expect(first.action).toBe("accepted");
      expect(first.balance_records).toHaveLength(1);
      expect((await tx`select count(*)::int count from public.import_row_decisions where source_id=${source}`)[0].count).toBe(1);
      await tx`select set_config('request.jwt.claim.sub',${other},true)`;
      await expect(tx.savepoint(sp => sp`select public.undo_import_row_decision(${first.id})`)).rejects.toMatchObject({ code: "P0002" });
      await tx`set local role authenticated`;
      expect(await tx`select id from public.import_row_decisions where source_id=${source}`).toHaveLength(0);
      await tx`reset role`;
      await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
      await tx`select public.undo_import_row_decision(${first.id})`;
      await tx`select public.undo_import_row_decision(${first.id})`;
      expect((await tx`select status,original_row from public.source_transactions where id=${source}`)[0]).toMatchObject({ status: "review", original_row: row.originalRow });
      expect((await tx`select review_rows,new_rows from public.imports where id=${imported}`)[0]).toMatchObject({ review_rows: 1, new_rows: 0 });
      expect(await tx`select id from public.balance_snapshots where id=${balance}`).toHaveLength(0);
      expect(await tx`select transaction_id from public.transaction_sources where source_transaction_id=${source}`).toHaveLength(0);
      expect((await tx`select transaction_record from public.import_row_decisions where id=${first.id}`)[0].transaction_record.amount_minor).toBe(-1200);
      await reject(); const rejected = await current();
      await expect(tx.savepoint(sp => sp`select public.undo_import_row_decision(${first.id})`)).rejects.toMatchObject({ code: "PT409" });
      await tx`select public.undo_import_row_decision(${rejected.id})`;
      await accept(); const accepted = await current();
      const target = accepted.transaction_record.id;
      const reviewedBalance = randomUUID();
      await tx`insert into public.balance_snapshots(id,workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind,covered_transactions,actor_id)
        values(${reviewedBalance},${workspace},${account},5000,'EUR',now(),'manual','reviewed_activity',${tx.json([{ id: target }])},${actor})`;
      await expect(tx.savepoint(sp => sp`select public.undo_import_row_decision(${accepted.id})`)).rejects.toThrow(/dependent reviewed balances/);
      await tx`delete from public.balance_snapshots where id=${reviewedBalance}`;
      const exclusion = randomUUID();
      await tx`insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row,status,review_reasons) values(${exclusion},${workspace},${imported},4,'{}','new',array['excluded_by_review'])`;
      await tx`update public.source_transactions set status='rejected' where id=${exclusion}`;
      expect(await tx`select id from public.import_row_decisions where source_id=${exclusion}`).toHaveLength(0);
      // An active match is a dependency even if the transaction's own fields never changed.
      const extra = randomUUID();
      await tx`insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row,status) values(${extra},${workspace},${imported},3,'{}','matched')`;
      await tx`insert into public.transaction_sources(transaction_id,source_transaction_id) values(${target},${extra})`;
      await expect(tx.savepoint(sp => sp`select public.undo_import_row_decision(${accepted.id})`)).rejects.toThrow(/other source evidence/);
      await tx`delete from public.transaction_sources where source_transaction_id=${extra}`;
      await tx`update public.transactions set description='Later edit' where id=${target}`;
      await expect(tx.savepoint(sp => sp`select public.undo_import_row_decision(${accepted.id})`)).rejects.toThrow(/later transaction changes/);
      expect((await tx`select status from public.source_transactions where id=${source}`)[0].status).toBe("accepted");
      expect((await tx`select undone_at from public.import_row_decisions where id=${accepted.id}`)[0].undone_at).toBeNull();
      // Correction history is retained after Undo, so both states refuse with the same honest reason.
      const version = async () => (await tx`select version from public.transactions where id=${target}`)[0].version;
      await tx`select public.correct_transaction(${target},${await version()},'Groceries','Corrected')`;
      await expect(tx.savepoint(sp => sp`select public.undo_import_row_decision(${accepted.id})`)).rejects.toThrow(/correction history is kept/);
      const [{ id: correction }] = await tx`select id from public.correction_events where transaction_id=${target} and not undone`;
      await tx`select public.undo_transaction_correction(${correction},${await version()})`;
      await expect(tx.savepoint(sp => sp`select public.undo_import_row_decision(${accepted.id})`)).rejects.toThrow(/correction history is kept/);
      expect((await tx`select status from public.source_transactions where id=${source}`)[0].status).toBe("accepted");
      expect(await tx`select id from public.transactions where id=${target}`).toHaveLength(1);
      await tx`select public.reset_workspace()`;
      expect(await tx`select id from public.import_row_decisions where workspace_id=${workspace}`).toHaveLength(0);
      const [{ id: replacement }] = await tx`select id from public.workspaces where owner_id=${actor}`;
      const newImport = randomUUID(), newSource = randomUUID();
      await tx`insert into public.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,review_rows) values(${newImport},${replacement},'delete.csv','synthetic',${newImport},'completed',1,1)`;
      await tx`insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row,status) values(${newSource},${replacement},${newImport},2,'{}','review')`;
      await tx`select public.resolve_normalized_import_review(${newSource},'reject')`;
      expect(await tx`select id from public.import_row_decisions where source_id=${newSource}`).toHaveLength(1);
      await tx`select public.delete_account()`;
      expect(await tx`select id from public.import_row_decisions where workspace_id=${replacement}`).toHaveLength(0);
      expect(await tx`select id from auth.users where id=${actor}`).toHaveLength(0);
      throw rollback;
    })).rejects.toBe(rollback);
  } finally { await db.end(); }
}, 60000);
