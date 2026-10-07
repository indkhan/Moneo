import { expect, it, vi } from "vitest";
import type { requireWorkspace } from "@/lib/auth";
import { retainToolSourceSupport } from "./tool-source-support";
const fixture = vi.hoisted(() => ({ revision: "source-v1", amount: "-25" }));
vi.mock("./investigation-reader", () => ({ loadInvestigationDataset: async () => ({ sourceRevision: fixture.revision, rows: [{ id: "row", parentId: "parent", accountId: "account", date: "2026-09-01", amountMinor: fixture.amount, currency: "EUR", status: "posted", kind: "ordinary", reviewReasons: [], version: 1, sourceVersions: { normalized: fixture.revision } }] }) }));
const context = {} as Awaited<ReturnType<typeof requireWorkspace>>;
const result = { from: "2026-09-01", to: "2026-09-30", spendingMinor: "25", calculationEvidence: { rows: [{ id: "row", parent_transaction_id: "parent", account_id: "account", posted_on: "2026-09-01", amount_minor: "-25", currency_code: "EUR", status: "posted", kind: "ordinary", review_reasons: [], version: 1 }] } };
it("retains imported origin versions and refuses a changed calculation read", async () => {
  const first = await retainToolSourceSupport("analytics_cashflow", {}, result, context, true);
  expect(first).toMatchObject({ calculationEvidence: { originSourceRevision: "source-v1", supportingSourceVersions: [{ sourceVersions: { normalized: "source-v1" } }] } });
  fixture.revision = "source-v2";
  expect(await retainToolSourceSupport("analytics_cashflow", {}, result, context, true)).not.toEqual(first);
  fixture.amount = "-26";
  await expect(retainToolSourceSupport("analytics_cashflow", {}, result, context, true)).rejects.toThrow(/changed/);
});
