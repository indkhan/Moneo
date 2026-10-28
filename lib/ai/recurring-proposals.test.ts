import { expect, it } from "vitest";
import { applyRecurringProposal, proposeRecurring } from "@/lib/ai/recurring-proposals";

type Rows = Record<string, unknown[]>;
function fakeDb(rows: Rows) {
  const inserts: { table: string; row: Record<string, unknown> }[] = [], calls: { name: string; args: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const name of ["select", "eq", "is", "in", "order", "limit", "or", "range"]) query[name] = () => query;
    query.maybeSingle = async () => ({ data: rows[table]?.[0] ?? null, error: null });
    const single = { select: () => ({ single: async () => ({ data: { id: "00000000-0000-4000-8000-000000000001" }, error: null }) }) };
    query.insert = (row: Record<string, unknown>) => { inserts.push({ table, row }); return single; };
    query.upsert = (row: Record<string, unknown>) => { inserts.push({ table, row }); return single; };
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve);
    return query;
  };
  const rpc = async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return { data: {}, error: null }; };
  return { inserts, calls, context: { supabase: { from, rpc }, workspace: { id: "w", timezone: "Europe/Berlin", locale: "en-IE" } } as never };
}
const bank = { id: "00000000-0000-4000-8000-0000000000bb", name: "N26", type: "checking", currency_code: "EUR" };
const gym = { id: "00000000-0000-4000-8000-0000000000cc", version: 3, name: "Gym", amount_minor: "-2990", currency_code: "EUR", cadence: "monthly", starts_on: "2026-10-01", schedule_anchor_on: null, account_id: bank.id, category: null };

it("proposes incoming salary with a category in exact minor units and changes nothing yet", async () => {
  const { inserts, calls, context } = fakeDb({ accounts: [bank] });
  const result = await proposeRecurring(context, { action: "add", name: "Salary", amount: "3200", direction: "in", currency: "EUR", nextDate: "2026-11-25", category: "Job" });
  expect(inserts).toHaveLength(1);
  expect(inserts[0]).toMatchObject({ table: "agent_proposals", row: { kind: "recurring_edit", payload: { action: "add", accountId: bank.id,
    fields: { name: "Salary", amountMinor: "320000", cadence: "monthly", startsOn: "2026-11-25", category: "Job" } } } });
  expect(result.title).toContain("coming in");
  expect(calls).toHaveLength(0);
});

it("proposes only the changed fields of a named schedule, keeping its direction", async () => {
  const { inserts, context } = fakeDb({ financial_assumptions: [gym] });
  await proposeRecurring(context, { action: "change", target: "gym", amount: "34.90" });
  expect(inserts[0].row.payload).toEqual({ action: "change", assumptionId: gym.id, changes: { amountMinor: "-3490" } });
  await expect(proposeRecurring(context, { action: "change", target: "gym" })).rejects.toThrow("Say what to change");
  await expect(proposeRecurring(context, { action: "remove", target: "netflix" })).rejects.toThrow('No recurring payment matches "netflix"');
});

it("applies a change and a removal through the audited edit with the proposal as request id", async () => {
  const { calls, context } = fakeDb({ financial_assumptions: [gym] });
  const id = "00000000-0000-4000-8000-0000000000dd";
  await applyRecurringProposal(context, id, { action: "change", assumptionId: gym.id, changes: { amountMinor: "-3490" } });
  expect(calls[0]).toEqual({ name: "edit_assumption", args: { p_id: gym.id, p_expected_version: 3, p_patch: { amount_minor: "-3490", kind: "expense" }, p_request_id: id } });
  await applyRecurringProposal(context, id, { action: "remove", assumptionId: gym.id });
  expect(calls[1].args).toMatchObject({ p_patch: { removed: true }, p_request_id: id });
});

it("adds a schedule with its category on accept", async () => {
  const { inserts, context } = fakeDb({ accounts: [bank] });
  await applyRecurringProposal(context, "p", { action: "add", accountId: bank.id, fields: { name: "Salary", amountMinor: "320000", cadence: "monthly", startsOn: "2026-11-25", category: "Job" } });
  expect(inserts.map(item => item.table)).toEqual(["categories", "financial_assumptions"]);
  expect(inserts[1].row).toMatchObject({ kind: "income", amount_minor: "320000", category_id: "00000000-0000-4000-8000-000000000001", source: "user", confirmed: true });
});
