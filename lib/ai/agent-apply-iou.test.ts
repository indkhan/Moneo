import { expect, it, vi } from "vitest";
import { applyProposal } from "@/lib/ai/agent-apply";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
vi.mock("@/lib/import/organization-loader", () => ({ loadOrganizationSuggestions: vi.fn() }));

const item = { id: id(20), kind: "asset", name: "Lent to Mohammed", currency_code: "EUR", amount_minor: "50000", as_of: "2026-10-01", version: 2, removed_at: null, linked_account_id: null, annual_rate_text: null, monthly_payment_minor: null };
function fakeContext(rows: Record<string, unknown>) {
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const supabase = {
    rpc: async (name: string, args: Record<string, unknown>) => { rpcs.push({ name, args }); return { data: null, error: null }; },
    from: (table: string) => { const query = { select: () => query, eq: () => query, is: () => query, maybeSingle: async () => ({ data: rows[table] ?? null, error: null }) }; return query; },
  };
  return { rpcs, context: { supabase, workspace: { id: id(1), timezone: "Europe/Berlin" } } as never };
}

it("accepting a new loan saves a Wealth asset keyed by the proposal id", async () => {
  const { rpcs, context } = fakeContext({});
  await applyProposal(context, { id: id(5), kind: "iou_create", payload: { direction: "lent", person: "Mohammed", amountMinor: "50000", currencyCode: "EUR", date: "2026-10-26" } });
  expect(rpcs).toEqual([{ name: "edit_wealth_item", args: expect.objectContaining({ p_id: id(5), p_request_id: id(5), p_expected_version: 0, p_remove: false,
    p_record: expect.objectContaining({ kind: "asset", name: "Lent to Mohammed", amount_minor: "50000" }) }) }]);
});

it("accepting a partial repayment lowers what is left at the item's current version", async () => {
  const { rpcs, context } = fakeContext({ wealth_items: item, transactions: { id: id(30), amount_minor: "48000", currency_code: "EUR" } });
  await applyProposal(context, { id: id(6), kind: "iou_settle", payload: { itemId: id(20), transactionId: id(30), appliedMinor: "48000" } });
  expect(rpcs[0].args).toMatchObject({ p_id: id(20), p_expected_version: 2, p_remove: false, p_request_id: id(6), p_record: { amount_minor: "2000" } });
});

it("a full repayment removes the item", async () => {
  const { rpcs, context } = fakeContext({ wealth_items: item, transactions: { id: id(30), amount_minor: "50000", currency_code: "EUR" } });
  await applyProposal(context, { id: id(6), kind: "iou_settle", payload: { itemId: id(20), transactionId: id(30), appliedMinor: "50000" } });
  expect(rpcs[0].args).toMatchObject({ p_remove: true, p_record: {} });
});

it("refuses a repayment whose item or transaction changed", async () => {
  const payload = { itemId: id(20), transactionId: id(30), appliedMinor: "48000" };
  await expect(applyProposal(fakeContext({ transactions: { id: id(30), amount_minor: "48000", currency_code: "EUR" } }).context, { id: id(6), kind: "iou_settle", payload })).rejects.toThrow("changed or was removed");
  await expect(applyProposal(fakeContext({ wealth_items: item, transactions: { id: id(30), amount_minor: "-48000", currency_code: "EUR" } }).context, { id: id(6), kind: "iou_settle", payload })).rejects.toThrow("no longer matches");
});
