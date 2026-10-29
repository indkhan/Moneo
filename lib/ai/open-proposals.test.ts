import { expect, it } from "vitest";
import { openStandaloneProposals } from "@/lib/ai/open-proposals";

function fakeDb(rows: Record<string, unknown[]>) {
  const calls: unknown[][] = [];
  const from = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const name of ["select", "eq", "is", "in", "order", "limit"]) query[name] = (...args: unknown[]) => { calls.push([table, name, ...args]); return query; };
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve);
    return query;
  };
  return { calls, db: { from } as never };
}

const cash = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const expense = { id: "t", kind: "transaction_create", title: "Spent €12.00 · Lunch", detail: "Today", status: "proposed",
  payload: { direction: "spent", amountMinor: "1200", currencyCode: "EUR", date: "2026-10-28", description: "Lunch", accountId: cash, categoryId: null } };
const balance = { id: "b", kind: "balance_set", title: "Cash is €40.00", detail: "", status: "failed", payload: {} };

it("reads only this workspace's open cards outside agent runs, oldest first", async () => {
  const { calls, db } = fakeDb({ agent_proposals: [] });
  expect(await openStandaloneProposals(db, "w")).toEqual([]);
  expect(calls).toEqual(expect.arrayContaining([["agent_proposals", "eq", "workspace_id", "w"], ["agent_proposals", "is", "run_id", null],
    ["agent_proposals", "in", "status", ["proposed", "failed"]], ["agent_proposals", "in", "kind", ["iou_create", "iou_settle", "transaction_create", "balance_set", "recurring_edit"]],
    ["agent_proposals", "order", "created_at"]]));
});

it("gives expense cards their account choices and leaves other cards as stored", async () => {
  const { db } = fakeDb({ agent_proposals: [expense, balance], accounts: [{ id: cash, name: "Wallet", type: "cash", currency_code: "EUR" }] });
  expect(await openStandaloneProposals(db, "w")).toEqual([
    { id: "t", kind: "transaction_create", title: expense.title, detail: "Today", status: "proposed", accounts: [{ id: cash, name: "Wallet" }], selected: cash, needsCash: false },
    { id: "b", kind: "balance_set", title: balance.title, detail: "", status: "failed" },
  ]);
});
