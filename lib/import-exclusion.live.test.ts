import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { expect, it } from "vitest";

it.skipIf(process.env.RUN_IMPORT_EXCLUSION_DB_TESTS !== "1")("preserves exclusions, progress, fencing and immutable identity in a rolled-back SQL transaction", async () => {
  process.loadEnvFile(".env");
  const endpoint = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!), connection = new URL(process.env.SUPABASE_DB_URL!);
  expect(connection.hostname === `db.${endpoint.hostname.split(".")[0]}.supabase.co` || connection.username.endsWith(`.${endpoint.hostname.split(".")[0]}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1, onnotice: () => {} });
  const rollback = new Error("Successful rollback");
  try {
    try { await db.begin(async tx => {
      const migration = "supabase/migrations/202610060002_import_row_exclusions.sql";
      if (existsSync(migration)) await tx.unsafe(readFileSync(migration, "utf8"));
      expect((await tx`select to_regprocedure('public.record_import_exclusion(uuid,uuid,integer,jsonb)') present`)[0].present).not.toBeNull();
      const actor = randomUUID();
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
      throw rollback;
    }); } catch (error) { if (error !== rollback) throw error; }
  } finally { await db.end(); }
}, 30000);
