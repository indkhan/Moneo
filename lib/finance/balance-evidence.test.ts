import { expect, it, vi } from "vitest";
import { getBalances } from "./tools";
import type { requireWorkspace } from "@/lib/auth";
const fixture = vi.hoisted(() => ({ evidence: { accounts: [{ id: "account", currency_code: "EUR", name: "Synthetic" }], snapshots: [{ id: "snapshot", account_id: "account", amount_minor: "20", currency_code: "EUR", as_of: "2026-10-01T00:00:00Z", provenance: "manual" }], ledger: [{ id: "transaction", account_id: "account", amount_minor: "-10", currency_code: "EUR", posted_on: "2026-10-02", status: "posted" }], asOf: "2026-10-02T12:00:00Z" } }));
vi.mock("./balances", async original => ({ ...await original<typeof import("./balances")>(), loadBalanceEvidence: async () => fixture.evidence }));
it("keeps account support internal by default while retaining complete calculation inputs for trusted receipts", async () => {
  const context = { supabase: {}, workspace: { id: "owned", timezone: "UTC" } } as Awaited<ReturnType<typeof requireWorkspace>>;
  expect(await getBalances(context, false)).not.toEqual(expect.arrayContaining([expect.objectContaining({ calculationEvidence: expect.anything() })]));
  expect(await getBalances(context, false, true)).toEqual(expect.arrayContaining([expect.objectContaining({ calculationEvidence: { snapshots: fixture.evidence.snapshots, ledger: fixture.evidence.ledger } })]));
});
