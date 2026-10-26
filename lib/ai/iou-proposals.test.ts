import { expect, it } from "vitest";
import { proposeIou, proposeRepayments } from "@/lib/ai/iou-proposals";

type Rows = Record<string, unknown[]>;
function fakeDb(rows: Rows) {
  const inserts: { table: string; row: unknown }[] = [];
  const from = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const name of ["select", "eq", "is", "in", "gte", "order", "limit"]) query[name] = () => query;
    query.insert = (row: unknown) => { inserts.push({ table, row }); const list = Array.isArray(row) ? row : [row]; const result = { data: list.map((_, index) => ({ id: `new-${index}`, title: (list[index] as { title: string }).title })), error: null };
      return { select: () => ({ ...result, single: async () => ({ data: result.data[0], error: null }), then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) }) }; };
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve);
    return query;
  };
  return { inserts, context: { supabase: { from }, workspace: { id: "w", timezone: "Europe/Berlin", locale: "en-IE" } } as never };
}

it("proposing a loan stores exact minor units and writes nothing to Wealth", async () => {
  const { inserts, context } = fakeDb({});
  const result = await proposeIou(context, { direction: "lent", person: "Mohammed", amount: "500", currency: "EUR" });
  expect(inserts).toHaveLength(1);
  expect(inserts[0].table).toBe("agent_proposals");
  expect(inserts[0].row).toMatchObject({ kind: "iou_create", payload: { direction: "lent", person: "Mohammed", amountMinor: "50000", currencyCode: "EUR" } });
  expect(result.title).toContain("Mohammed owes you");
});

it("rejects a future date and an unknown currency", async () => {
  const { context } = fakeDb({});
  await expect(proposeIou(context, { direction: "lent", person: "Sam", amount: "5", currency: "EUR", date: "2999-01-01" })).rejects.toThrow("future");
  await expect(proposeIou(context, { direction: "lent", person: "Sam", amount: "5", currency: "ZZZ" })).rejects.toThrow();
});

const item = { id: "i1", kind: "asset", name: "Lent to Mohammed", currency_code: "EUR", amount_minor: "50000", as_of: "2026-10-01", version: 1, removed_at: null, linked_account_id: null };
const transaction = { id: "t1", description: "Mohammed Ali", amount_minor: "48000", currency_code: "EUR", posted_on: "2026-10-10" };

it("proposes a found repayment once; a known match is not proposed again", async () => {
  const fresh = fakeDb({ wealth_items: [item], transactions: [transaction], agent_proposals: [] });
  await proposeRepayments(fresh.context);
  expect(fresh.inserts[0].row).toEqual([expect.objectContaining({ kind: "iou_settle", conflict_key: "iou_settle:i1:t1", payload: { itemId: "i1", transactionId: "t1", appliedMinor: "48000" } })]);
  const known = fakeDb({ wealth_items: [item], transactions: [transaction], agent_proposals: [{ conflict_key: "iou_settle:i1:t1" }] });
  await proposeRepayments(known.context);
  expect(known.inserts).toEqual([]);
});

it("does nothing without open loans", async () => {
  const { inserts, context } = fakeDb({ wealth_items: [{ ...item, name: "Savings" }], transactions: [transaction] });
  expect(await proposeRepayments(context)).toEqual([]);
  expect(inserts).toEqual([]);
});
