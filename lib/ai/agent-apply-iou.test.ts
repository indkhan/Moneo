import { expect, it, vi } from "vitest";
import { applyProposal } from "@/lib/ai/agent-apply";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
vi.mock("@/lib/import/organization-loader", () => ({ loadOrganizationSuggestions: vi.fn() }));

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

it("accepting a repayment links it to the bank payment in one audited step, keyed by the proposal", async () => {
  const { rpcs, context } = fakeContext({});
  await applyProposal(context, { id: id(6), kind: "iou_settle", payload: { itemId: id(20), transactionId: id(30), appliedMinor: "48000" } });
  expect(rpcs).toEqual([{ name: "apply_iou_repayment", args: { p_item_id: id(20), p_transaction_id: id(30), p_applied_minor: "48000", p_request_id: id(6) } }]);
});

it("passes on the database refusing a repayment that no longer holds", async () => {
  const supabase = { rpc: async () => ({ data: null, error: { message: "This payment has already been counted against a loan" } }) };
  await expect(applyProposal({ supabase, workspace: { id: id(1), timezone: "Europe/Berlin" } } as never, { id: id(6), kind: "iou_settle", payload: { itemId: id(20), transactionId: id(30), appliedMinor: "48000" } })).rejects.toThrow("already been counted");
});
