import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import postgres from "postgres";
import { afterEach, expect, it, vi } from "vitest";
import { mapRows, parseCsv } from "@/lib/csv";
import { importRowPayload, stableId } from "@/lib/import-row";
import { POST } from "./route";

// Mock only the storage/Supabase transport boundary; all reads and RPCs below
// execute against actual PostgreSQL roles/RLS in one rolled-back fresh schema.
const fixture = vi.hoisted(() => ({ workspaceId: "", csv: "", tampered: false,
  read: (async () => ({ data: null as unknown, error: null })) as (table: string, filters: [string, unknown][]) => Promise<{ data: unknown; error: null }>,
  rpc: (async () => ({ data: null as unknown, error: null })) as (service: boolean, name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: null }>,
}));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: fixture.workspaceId }, supabase: {
  from: (table: string) => {
    const filters: [string, unknown][] = [];
    const query = { select: () => query, eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      maybeSingle: () => fixture.read(table, filters), single: () => fixture.read(table, filters) };
    return query;
  }, rpc: (name: string, args: Record<string, unknown>) => fixture.rpc(false, name, args),
} }) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  storage: { from: () => ({ download: async () => ({ data: new Blob([fixture.csv + (fixture.tampered ? "changed" : "")]), error: null }) }) },
  rpc: (name: string, args: Record<string, unknown>) => fixture.rpc(true, name, args),
}) }));
afterEach(() => { vi.unstubAllEnvs(); fixture.tampered = false; });

it.skipIf(process.env.RUN_IMPORT_EXCLUSION_DB_TESTS !== "1")("runs hash-verified legacy parsing/preparation through the authenticated RPC with ingestion parity, retry and undo", async () => {
  process.loadEnvFile(".env");
  const connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-mocked-storage-boundary");
  const db = postgres(connection.toString(), { ssl: "require", max: 1, onnotice: () => {} });
  const schema = `mne007_route_qa_${Date.now()}`;
  const rollback = new Error("successful route integration rollback");
  const actor = randomUUID(), account = randomUUID(), replacement = randomUUID();
  try {
    const applied = await db`select version from supabase_migrations.schema_migrations order by version`;
    try { await db.begin(async tx => {
      await tx.unsafe(`create schema ${schema}; create table ${schema}.auth_users(id uuid primary key,email text); grant usage on schema ${schema} to authenticated,service_role`);
      const isolated = (sql: string) => sql.replace(/\bpublic\./g, `${schema}.`).replace(/\bauth\.users\b/g, `${schema}.auth_users`);
      for (const file of readdirSync("supabase/migrations").filter(file => file.endsWith(".sql")).sort()) {
        let sql = readFileSync(`supabase/migrations/${file}`, "utf8");
        if (file.endsWith("_initial.sql")) sql = sql.slice(0, sql.indexOf("insert into storage.buckets"));
        await tx.unsafe(isolated(sql));
      }
      await tx.unsafe(`insert into ${schema}.auth_users(id,email) values($1,'synthetic@example.invalid')`, [actor]);
      const [{ id: workspace }] = await tx.unsafe(`select id from ${schema}.workspaces where owner_id=$1`, [actor]);
      fixture.workspaceId = workspace;
      await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
      await tx.unsafe(`insert into ${schema}.accounts(id,workspace_id,name,currency_code) values($1,$2,'Frozen','EUR')`, [account, workspace]);
      fixture.read = async (table, filters) => {
        if (!["imports", "source_transactions"].includes(table) || filters.some(([key]) => !["id", "workspace_id", "import_id"].includes(key))) throw new Error("Unexpected integration read");
        await tx.unsafe("set local role authenticated");
        const rows = await tx.unsafe(`select * from ${schema}.${table} where ${filters.map(([key], index) => `${key}=$${index + 1}`).join(" and ")}`, filters.map(([, value]) => value as string));
        return { data: rows[0] ?? null, error: null };
      };
      fixture.rpc = async (service, name, args) => {
        expect(name).toBe(service ? "prepare_import_review" : "resolve_normalized_import_review");
        await tx.unsafe(`set local role ${service ? "service_role" : "authenticated"}`);
        const rows = service
          ? await tx.unsafe(`select ${schema}.prepare_import_review($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)`, [args.p_source_id as string, args.p_workspace_id as string, args.p_mapping as postgres.JSONValue, args.p_routes as postgres.JSONValue, args.p_row as postgres.JSONValue])
          : await tx.unsafe(`select to_jsonb(${schema}.resolve_normalized_import_review($1,$2,$3,$4,$5)) row`, [args.p_source_id as string, args.p_action as string, args.p_expected_route_id as string | null, args.p_account_id as string | null, args.p_expected_account_version as number | null]);
        return { data: rows[0].row ?? null, error: null };
      };
      for (const excludedFooter of [false, true]) {
        const imported = randomUUID(), ordinaryImport = randomUUID(), source = randomUUID(), ordinaryAccount = randomUUID();
        const ordinaryName = excludedFooter ? "Ordinary with exclusions" : "Ordinary";
        fixture.csv = 'Date,Description,Amount,Balance,Fee,Type,State,Merchant,Category,External\n2026-09-01T07:00:00Z,Opening,1,100,0,Card payment,COMPLETED,Shop,Opening,opening\nbad,amzn refund,2,102,"0,50",Card refund,COMPLETED,amzn, Refunds ,refund' + (excludedFooter ? '\n,Footer,,,,,,,,footer' : '');
        const mapping = { accountName: "Frozen", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", balanceColumn: "Balance", feeColumn: "Fee", typeColumn: "Type", statusColumn: "State", merchantColumn: "Merchant", categoryColumn: "Category", externalIdColumn: "External", dateFormat: "iso", amountSign: "signed", numericConvention: "decimal-comma", rowContractVersion: "normalized-row-v1", calendarTimezone: "Europe/Berlin", rowDecisions: [{ rowNumber: 3, action: "correct", values: { Date: "2026-09-01T10:00:00+02:00" } }, ...(excludedFooter ? [{ rowNumber: 4, action: "exclude", reason: "Footer" }] : [])] };
        const originals = parseCsv(fixture.csv), mapped = mapRows(originals, mapping);
        const routes = { '["Frozen", "EUR"]': account };
        const fileHash = createHash("sha256").update(fixture.csv).digest("hex");
        await tx.unsafe("reset role");
        await tx.unsafe(`insert into ${schema}.accounts(id,workspace_id,name,currency_code) values($1,$2,$3,'EUR')`, [ordinaryAccount, workspace, ordinaryName]);
        await tx.unsafe(`insert into ${schema}.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping,route_accounts,review_rows) values($1,$2,'synthetic.csv',$3,$4,'completed',$5,$6::jsonb,$7::jsonb,1)`, [imported, workspace, `${workspace}/synthetic.csv`, fileHash, originals.length, mapping, routes]);
        await tx.unsafe(`insert into ${schema}.source_transactions(id,workspace_id,import_id,row_number,original_row,status,review_reasons) values($1,$2,$3,3,$4::jsonb,'review',array['fee_semantics'])`, [source, workspace, imported, originals[1]]);
        await tx.unsafe(`insert into ${schema}.imports(id,workspace_id,filename,storage_path,file_hash,status,total_rows,mapping) values($1,$2,'ordinary.csv','synthetic',$3,'queued',$4,$5::jsonb)`, [ordinaryImport, workspace, ordinaryImport, originals.length, mapping]);
        await tx.unsafe(`select ${schema}.prepare_import_route($1,$2,1,$3,$4,$5,'EUR',$6)`, [ordinaryImport, workspace, ordinaryAccount, randomUUID(), ordinaryName, originals.length]);
        const ordinaryPayload = importRowPayload(workspace, ordinaryImport, { ...mapped[1], accountName: ordinaryName });
        for (const row of mapped) await tx.unsafe(`select ${schema}.ingest_import_row($1,$2,1,$3,$4::jsonb)`, [ordinaryImport, workspace, ordinaryAccount, { ...importRowPayload(workspace, ordinaryImport, { ...row, accountName: ordinaryName }), action: "new", transactionId: stableId(`${ordinaryImport}:transaction:${row.rowNumber}`) }]);
        if (excludedFooter) await tx.unsafe(`select ${schema}.record_import_exclusion($1,$2,1,$3::jsonb)`, [ordinaryImport, workspace, { sourceId: stableId(`${ordinaryImport}:row:4`), rowNumber: 4, reason: "Footer", originalRow: originals[2] }]);
        await tx.unsafe(`select ${schema}.finish_import_run($1,$2,1,null)`, [ordinaryImport, workspace]);
        if (!excludedFooter) {
          await tx.unsafe(`update ${schema}.accounts set name='Renamed',version=version+1 where id=$1`, [account]);
          await tx.unsafe(`insert into ${schema}.accounts(id,workspace_id,name,currency_code) values($1,$2,'Frozen','EUR')`, [replacement, workspace]);
        }
        const request = () => new Request("http://localhost/review", { method: "POST", body: JSON.stringify({ sourceId: source, action: "accept" }) });
        fixture.tampered = true;
        const bad = await POST(request(), { params: Promise.resolve({ id: imported }) });
        expect(bad.status).toBe(400);
        expect(await bad.json()).toMatchObject({ error: "Stored import file differs from the reviewed original" });
        fixture.tampered = false;
        for (let retry = 0; retry < 2; retry++) {
          const response = await POST(request(), { params: Promise.resolve({ id: imported }) });
          expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
          expect(await response.json()).toEqual({ status: "accepted" });
        }
        await tx.unsafe("reset role");
        const [{ evidence, original, fee }] = await tx.unsafe(`select normalized_row evidence,original_row original,fee_evidence fee from ${schema}.source_transactions where id=$1`, [source]);
        expect(original).toEqual(originals[1]);
        expect(evidence.row).toMatchObject({ rowNumber: 3, postedAt: "2026-09-01T08:00:00.000Z", balanceAsOf: "2026-09-01T08:00:00.000Z", kind: "refund", merchantName: "Amazon", categoryName: "Refunds", amountMinor: "200", balanceMinor: "10200", currencyCode: "EUR", calendarTimezone: "Europe/Berlin" });
        expect(fee).toMatchObject({ treatment: excludedFooter ? "unknown" : "included", feeMinor: "50", ...(!excludedFooter ? { deltaMinor: "200", previousRowNumber: 2 } : {}) });
        expect(evidence.resolution).toMatchObject({ accountId: account, actorId: actor });
        const canonical = await tx.unsafe(`select to_jsonb(t)-array['id','account_id','created_at'] record,t.account_id from ${schema}.transactions t join ${schema}.transaction_sources l on l.transaction_id=t.id where l.source_transaction_id in ($1,$2) order by l.source_transaction_id`, [source, ordinaryPayload.sourceId]);
        expect(canonical).toHaveLength(2);
        expect(canonical[0].record).toEqual(canonical[1].record);
        expect(canonical.map(row => row.account_id).sort()).toEqual([account, ordinaryAccount].sort());
        const snapshots = await tx.unsafe(`select amount_minor::text,as_of,boundary_kind from ${schema}.balance_snapshots where source_transaction_id in ($1,$2) order by source_transaction_id`, [source, ordinaryPayload.sourceId]);
        expect(snapshots).toHaveLength(2);
        expect(snapshots[0]).toEqual(snapshots[1]);
        await tx.unsafe("set local role authenticated");
        await tx.unsafe(`select ${schema}.undo_import($1,1,1)`, [imported]);
        await tx.unsafe("reset role");
        expect((await tx.unsafe(`select original_row from ${schema}.source_transactions where id=$1`, [source]))[0].original_row).toEqual(originals[1]);
        expect(Number((await tx.unsafe(`select count(*) n from ${schema}.transaction_sources where source_transaction_id=$1`, [source]))[0].n)).toBe(0);
      }
      throw rollback;
    }); } catch (error) { if (error !== rollback) throw error; }
    expect(await db`select 1 from pg_namespace where nspname=${schema}`).toHaveLength(0);
    expect(await db`select version from supabase_migrations.schema_migrations order by version`).toEqual(applied);
  } finally { await db.end(); }
}, 65_000);
