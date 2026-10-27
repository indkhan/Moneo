import { expect, it } from "vitest";
import { applyBalanceProposal, proposeBalance } from "@/lib/ai/balance-proposals";

type Rows = Record<string, unknown[]>;
function fakeDb(rows: Rows) {
  const inserts: { table: string; row: Record<string, unknown> }[] = [], calls: { name: string; args: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const name of ["select", "eq", "is", "in", "order", "limit"]) query[name] = () => query;
    query.maybeSingle = async () => ({ data: rows[table]?.[0] ?? null, error: null });
    query.insert = (row: Record<string, unknown>) => { inserts.push({ table, row }); return { select: () => ({ single: async () => ({ data: { id: "00000000-0000-4000-8000-000000000001" }, error: null }) }) }; };
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve);
    return query;
  };
  const rpc = async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return { data: {}, error: null }; };
  return { inserts, calls, context: { supabase: { from, rpc }, workspace: { id: "w", timezone: "Europe/Berlin", locale: "en-IE" } } as never };
}
const wallet = { id: "00000000-0000-4000-8000-0000000000aa", name: "Wallet EUR", type: "cash", currency_code: "EUR" };
const bank = { id: "00000000-0000-4000-8000-0000000000bb", name: "Revolut", type: "checking", currency_code: "EUR" };

it("proposing a cash balance stores exact minor units and writes no snapshot", async () => {
  const { inserts, calls, context } = fakeDb({ accounts: [wallet, bank] });
  const result = await proposeBalance(context, { amount: "115", currency: "EUR", asOf: "2026-10-27" });
  expect(calls).toHaveLength(0);
  expect(inserts[0]).toMatchObject({ table: "agent_proposals", row: { kind: "balance_set", payload: { accountId: wallet.id, amountMinor: "11500", currencyCode: "EUR", asOf: "2026-10-27" } } });
  expect(result.title).toBe("Set Wallet EUR balance to EUR 115.00");
});

it("names the account when several match, and refuses future dates", async () => {
  const { context } = fakeDb({ accounts: [wallet, bank] });
  await expect(proposeBalance(context, { account: "revolut", amount: "5", currency: "EUR" })).resolves.toMatchObject({ title: expect.stringContaining("Revolut") });
  await expect(proposeBalance(context, { account: "nope", amount: "5", currency: "EUR" })).rejects.toThrow("No single EUR account");
  await expect(proposeBalance(context, { amount: "5", currency: "EUR", asOf: "2999-01-01" })).rejects.toThrow("future");
});

it("accepting records the balance against the latest snapshot, keyed by the proposal", async () => {
  const latest = { id: "00000000-0000-4000-8000-0000000000cc", version: 2 };
  const { calls, context } = fakeDb({ accounts: [wallet], balance_snapshots: [latest] });
  await applyBalanceProposal(context, "00000000-0000-4000-8000-0000000000dd", { accountId: wallet.id, amountMinor: "11500", currencyCode: "EUR", asOf: "2026-10-27" });
  expect(calls).toEqual([{ name: "record_manual_balance", args: expect.objectContaining({ p_amount_minor: "11500", p_date: "2026-10-27", p_reviewed: false,
    p_expected_snapshot_id: latest.id, p_expected_version: 2, p_request_id: "00000000-0000-4000-8000-0000000000dd" }) }]);
});

it("accepting refuses a currency the account does not use", async () => {
  const { calls, context } = fakeDb({ accounts: [wallet] });
  await expect(applyBalanceProposal(context, "p", { accountId: wallet.id, amountMinor: "100", currencyCode: "USD", asOf: "2026-10-27" })).rejects.toThrow("Choose an account in USD");
  expect(calls).toHaveLength(0);
});

it("uses the currency's only cash account, asks when several exist, and proposes creating one when none does", async () => {
  const { inserts, context } = fakeDb({ accounts: [wallet, bank] });
  await proposeBalance(context, { amount: "115", currency: "EUR" });
  expect(inserts[0].row).toMatchObject({ payload: { accountId: wallet.id } });
  const several = fakeDb({ accounts: [wallet, { ...wallet, id: "00000000-0000-4000-8000-0000000000ff", name: "Till" }] });
  await expect(proposeBalance(several.context, { amount: "5", currency: "EUR" })).rejects.toThrow("Name the EUR account");
  const none = fakeDb({ accounts: [bank] });
  const result = await proposeBalance(none.context, { amount: "115", currency: "EUR" });
  expect(result.title).toBe("Create a Cash EUR account and set its balance to EUR 115.00");
  expect(none.inserts[0].row).toMatchObject({ payload: { accountId: null, amountMinor: "11500" } });
});

it("accepting a proposal with no account creates the Cash account first", async () => {
  const { calls, inserts, context } = fakeDb({ accounts: [], balance_snapshots: [] });
  const result = await applyBalanceProposal(context, "00000000-0000-4000-8000-0000000000dd", { accountId: null, amountMinor: "11500", currencyCode: "EUR", asOf: "2026-10-27" });
  expect(inserts.find(insert => insert.table === "accounts")?.row).toMatchObject({ name: "Cash", type: "cash", currency_code: "EUR" });
  expect(calls[0]).toMatchObject({ name: "record_manual_balance", args: expect.objectContaining({ p_account_id: "00000000-0000-4000-8000-000000000001", p_amount_minor: "11500" }) });
  expect(result).toMatchObject({ createdAccount: true });
});
