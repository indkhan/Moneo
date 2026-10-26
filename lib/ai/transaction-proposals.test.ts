import { expect, it } from "vitest";
import { applyTransactionProposal, chooseAccount, proposeTransaction } from "@/lib/ai/transaction-proposals";

type Rows = Record<string, unknown[]>;
function fakeDb(rows: Rows) {
  const inserts: { table: string; row: Record<string, unknown> }[] = [], calls: { name: string; args: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const name of ["select", "eq", "is", "in", "ilike", "order", "limit"]) query[name] = () => query;
    query.maybeSingle = async () => ({ data: rows[table]?.[0] ?? null, error: null });
    query.insert = (row: Record<string, unknown>) => { inserts.push({ table, row }); return { select: () => ({ single: async () => ({ data: { id: `00000000-0000-4000-8000-00000000000${inserts.length}` }, error: null }) }) }; };
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve);
    return query;
  };
  const rpc = async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return { data: { id: "tx" }, error: null }; };
  return { inserts, calls, context: { supabase: { from, rpc }, workspace: { id: "w", timezone: "Europe/Berlin", locale: "en-IE" } } as never };
}
const cash = { id: "00000000-0000-4000-8000-0000000000aa", name: "Wallet", type: "cash", currency_code: "EUR" };
const bank = { id: "00000000-0000-4000-8000-0000000000bb", name: "N26 Main", type: "checking", currency_code: "EUR" };

it("picks a named account, else the cash account, else none", () => {
  expect(chooseAccount([cash, bank], "n26")).toBe(bank.id);
  expect(chooseAccount([cash, bank], "card")).toBe(bank.id);
  expect(chooseAccount([cash, bank])).toBe(cash.id);
  expect(chooseAccount([bank])).toBeNull();
});

it("proposing an expense stores exact minor units and writes no transaction", async () => {
  const { inserts, calls, context } = fakeDb({ accounts: [cash, bank], categories: [{ id: "00000000-0000-4000-8000-0000000000cc", name: "Food" }] });
  const result = await proposeTransaction(context, { direction: "spent", amount: "10", currency: "EUR", description: "Lunch", category: "food" });
  expect(calls).toHaveLength(0);
  expect(inserts[0]).toMatchObject({ table: "agent_proposals", row: { kind: "transaction_create", payload: { amountMinor: "1000", accountId: cash.id, categoryId: "00000000-0000-4000-8000-0000000000cc" } } });
  expect(result.title).toContain("Spent");
  await expect(proposeTransaction(context, { direction: "spent", amount: "1", currency: "EUR", description: "x", date: "2999-01-01" })).rejects.toThrow("future");
});

it("accepting records a negative manual transaction keyed by the proposal and creates Cash when missing", async () => {
  const { inserts, calls, context } = fakeDb({ accounts: [] });
  const payload = { direction: "spent", amountMinor: "1000", currencyCode: "EUR", date: "2026-10-01", description: "Lunch", accountId: null, categoryId: null };
  // The empty account list makes the currency check fail after creating Cash, proving the account is re-read before writing.
  await expect(applyTransactionProposal(context, "p", payload)).rejects.toThrow("Account not found");
  expect(inserts[0]).toMatchObject({ table: "accounts", row: { name: "Cash", type: "cash", currency_code: "EUR" } });
  const ready = fakeDb({ accounts: [cash] });
  const applied = await applyTransactionProposal(ready.context, "p", payload);
  expect(ready.calls[0]).toMatchObject({ name: "create_manual_transaction", args: { p_account_id: cash.id, p_amount_minor: "-1000", p_request_id: "p" } });
  expect(applied).toMatchObject({ href: "/money/transactions?transaction=tx", createdAccount: false });
  expect(calls).toHaveLength(0);
});
