import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { expect, it } from "vitest";
import { coveredTransaction, resolveBalances, type BalanceSnapshot, type BalanceTransaction } from "./balances";

it.skipIf(process.env.RUN_RESERVATION_DB_TESTS !== "1")("matches reviewed SQL and TS cash through fees, later postings, correction and soft undo", async () => {
  process.loadEnvFile(".env");
  const endpoint = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!), connection = new URL(process.env.SUPABASE_DB_URL!);
  expect(connection.hostname === `db.${endpoint.hostname.split(".")[0]}.supabase.co` || connection.username.endsWith(`.${endpoint.hostname.split(".")[0]}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1, onnotice: () => {} });
  const rollback = new Error("Successful rollback");
  try { try { await db.begin(async tx => {
    await tx.unsafe(readFileSync("supabase/migrations/202610060001_reviewed_balance_boundary.sql", "utf8"));
    const actor = randomUUID();
    await tx`insert into auth.users(id,email) values(${actor},${`qa-${actor}@example.invalid`})`;
    const [{ id: workspace }] = await tx`select id from public.workspaces where owner_id=${actor}`;
    const account = { id: randomUUID(), name: "Synthetic fee parity", currency_code: "EUR" };
    await tx`insert into public.accounts(id,workspace_id,name,currency_code) values(${account.id},${workspace},${account.name},'EUR')`;
    const ledger: BalanceTransaction[] = [
      { id: randomUUID(), account_id: account.id, amount_minor: "-100", currency_code: "EUR", posted_on: "2026-10-06", posted_at: "2026-10-06T08:00:00.000Z", status: "posted", version: 0 },
      { id: randomUUID(), account_id: account.id, amount_minor: "-200", currency_code: "EUR", posted_on: "2026-10-06", posted_at: null, status: "posted", version: 0 },
      { id: randomUUID(), account_id: account.id, amount_minor: "-250", currency_code: "EUR", posted_on: "2026-10-06", posted_at: "2026-10-06T13:00:00.000Z", status: "posted", version: 0 },
    ];
    for (const row of ledger) await tx`insert into public.transactions(id,workspace_id,account_id,amount_minor,currency_code,posted_on,posted_at,description,status)
      values(${row.id},${workspace},${account.id},${row.amount_minor},'EUR',${row.posted_on},${row.posted_at ?? null},'Synthetic fee posting','posted')`;
    const link = randomUUID();
    await tx`insert into public.transaction_links(id,workspace_id,primary_transaction_id,counterpart_transaction_id,operation,request_id,input,before_rows,after_rows,actor_id)
      values(${link},${workspace},${ledger[0].id},${ledger[2].id},'transfer',${randomUUID()},'{}','{}','{}',${actor})`;
    for (const row of [ledger[0], ledger[2]]) await tx`insert into public.transaction_link_fees(workspace_id,link_id,transaction_id,fee_minor,treatment,note)
      values(${workspace},${link},${row.id},50,'additional','Synthetic verified fee')`;
    const effective = ledger.map(row => ({ ...row, amount_minor: row.id === ledger[1].id ? row.amount_minor : (BigInt(row.amount_minor) - 50n).toString() }));
    const snapshot: BalanceSnapshot = { id: randomUUID(), account_id: account.id, amount_minor: "9007199254740993", currency_code: "EUR", as_of: "2026-10-06T12:00:00.000Z", provenance: "manual", boundary_kind: "reviewed_activity", covered_transactions: effective.slice(0, 2).map(coveredTransaction) };
    await tx`insert into public.balance_snapshots(id,workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind,covered_transactions,actor_id)
      values(${snapshot.id!},${workspace},${account.id},${snapshot.amount_minor},'EUR',${snapshot.as_of},'manual','reviewed_activity',${tx.json(snapshot.covered_transactions!)},${actor})`;
    const actualRecords = await tx`select public.balance_review_record(t) record from public.transactions t where t.id in(${ledger[0].id},${ledger[1].id}) order by t.id`;
    expect(actualRecords.map(row => row.record).sort((a, b) => a.id.localeCompare(b.id))).toEqual([...snapshot.covered_transactions!].sort((a, b) => a.id.localeCompare(b.id)));
    const asOf = "2026-10-06T14:00:00.000Z";
    async function parity(expected: string | null) {
      const [sql] = await tx`select public.reservation_balance_evidence(${account.id},${asOf},'Europe/Berlin') evidence`;
      const ts = resolveBalances([account], [snapshot], effective, asOf)[0].balance;
      expect(sql.evidence).toMatchObject({ status: ts.status, amount_minor: ts.amount_minor, estimated_amount_minor: ts.estimated_amount_minor });
      expect(ts.amount_minor).toBe(expected);
    }
    await parity("9007199254740693"); // covered fee is included already; later fee subtracts once.
    await tx`update public.transaction_link_fees set fee_minor=75 where transaction_id=${ledger[0].id}`;
    effective[0].amount_minor = "-175";
    await parity(null); // correcting covered financial evidence requires renewed review.
    await tx`update public.transaction_link_fees set fee_minor=50 where transaction_id=${ledger[0].id}`;
    effective[0].amount_minor = "-150";
    await parity("9007199254740693");
    await tx`update public.balance_snapshots set undone_at=now(),undone_by=${actor},version=2 where id=${snapshot.id!}`;
    snapshot.undone_at = asOf;
    await parity(null);
    throw rollback;
  }); } catch (error) { if (error !== rollback) throw error; } } finally { await db.end(); }
}, 30000);
