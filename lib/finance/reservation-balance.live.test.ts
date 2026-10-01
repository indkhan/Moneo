import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { expect, it } from "vitest";
import { resolveBalances } from "./balances";

it.skipIf(process.env.RUN_RESERVATION_DB_TESTS !== "1")("matches private SQL balance evidence to the application resolver on current, stale, tied and row-boundary fixtures", async () => {
  process.loadEnvFile(".env");
  const endpoint = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!), connection = new URL(process.env.SUPABASE_DB_URL!);
  expect(connection.hostname === `db.${endpoint.hostname.split(".")[0]}.supabase.co` || connection.username.endsWith(`.${endpoint.hostname.split(".")[0]}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1, onnotice: () => {} });
  const rollback = new Error("Successful rollback");
  const asOf = "2026-10-02T12:00:00Z";
  try {
    try { await db.begin(async tx => {
      if (!(await tx`select to_regclass('public.goal_reservation_events') present`)[0].present)
        await tx.unsafe(readFileSync("supabase/migrations/202610010034_goal_reservations.sql", "utf8"));
      const actor = randomUUID();
      await tx`insert into auth.users(id,email) values(${actor},${`qa-${actor}@example.invalid`})`;
      const [{ id: workspace }] = await tx`select id from public.workspaces where owner_id=${actor}`;
      for (const fixture of ["current", "stale", "same_day", "conflicting_ties", "after_row", "same_instant_unknown"] as const) {
        const account = { id: randomUUID(), name: fixture, currency_code: "EUR" };
        await tx`insert into public.accounts(id,workspace_id,name,currency_code) values(${account.id},${workspace},${fixture},'EUR')`;
        const boundary = fixture === "stale" ? "2026-10-01T10:00:00Z" : "2026-10-02T10:00:00Z";
        const afterRow = ["after_row", "same_instant_unknown"].includes(fixture);
        const source = randomUUID(), original = randomUUID();
        const snapshots = [{ id: randomUUID(), account_id: account.id, amount_minor: "9007199254740993", currency_code: "EUR", as_of: boundary, provenance: "synthetic", boundary_kind: afterRow ? "after_transaction" : "date_only", source_transaction_id: afterRow ? source : null }];
        const ledger: { id: string; account_id: string; amount_minor: string; currency_code: string; posted_on: string; posted_at?: string; source_transaction_ids?: string[]; status: string }[] = [];
        if (afterRow) {
          const imported = randomUUID();
          await tx`insert into public.imports(id,workspace_id,filename,storage_path,file_hash) values(${imported},${workspace},'golden.csv','synthetic',${imported})`;
          await tx`insert into public.source_transactions(id,workspace_id,import_id,row_number,original_row) values(${source},${workspace},${imported},2,'{}')`;
          ledger.push({ id: original, account_id: account.id, amount_minor: "-100", currency_code: "EUR", posted_on: "2026-10-02", posted_at: boundary, source_transaction_ids: [source], status: "posted" });
          ledger.push({ id: randomUUID(), account_id: account.id, amount_minor: "-200", currency_code: "EUR", posted_on: "2026-10-02", posted_at: fixture === "same_instant_unknown" ? boundary : "2026-10-02T11:00:00Z", status: "posted" });
        } else if (["same_day", "stale"].includes(fixture)) {
          ledger.push({ id: randomUUID(), account_id: account.id, amount_minor: "-200", currency_code: "EUR", posted_on: "2026-10-02", status: "posted" });
        }
        for (const row of ledger) await tx`insert into public.transactions(id,workspace_id,account_id,amount_minor,currency_code,posted_on,posted_at,description,status)
          values(${row.id},${workspace},${account.id},${row.amount_minor},'EUR',${row.posted_on},${row.posted_at ?? null},'Synthetic golden ledger',${row.status})`;
        if (afterRow) await tx`insert into public.transaction_sources(transaction_id,source_transaction_id) values(${original},${source})`;
        if (fixture === "conflicting_ties") snapshots.push({ ...snapshots[0], id: randomUUID(), amount_minor: "9007199254740992" });
        for (const snapshot of snapshots) await tx`insert into public.balance_snapshots(id,workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind,source_transaction_id)
          values(${snapshot.id},${workspace},${account.id},${snapshot.amount_minor},'EUR',${snapshot.as_of},'synthetic',${snapshot.boundary_kind},${snapshot.source_transaction_id})`;
        const [sql] = await tx`select public.reservation_balance_evidence(${account.id},${asOf},'Europe/Berlin') evidence`;
        const application = resolveBalances([account], snapshots, ledger, asOf)[0].balance;
        expect(sql.evidence, fixture).toMatchObject({ status: application.status, amount_minor: application.amount_minor, estimated_amount_minor: application.estimated_amount_minor });
      }
      throw rollback;
    }); } catch (error) { if (error !== rollback) throw error; }
  } finally { await db.end(); }
}, 30000);
