import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { requireWorkspace } from "@/lib/auth";
import { settingsSchema } from "@/lib/settings";
import { getBalances } from "./tools";
import { buildReviewEvidence } from "./review";
import { providerFinancialAnswer, toolResultReceipt } from "./tool-evidence";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const now = "2026-10-01T12:00:00Z";
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(now)); });
afterEach(() => vi.useRealTimers());

it.each(["manual", "import:00000000-0000-4000-8000-000000000002:row:7", "unknown"])("discloses actual %s snapshot provenance through balance loaders and standalone publication", async provenance => {
  const accounts = [{ id: "cash", name: "Cash", type: "checking", currency_code: "EUR", version: 1 }];
  const snapshots = [{ id: "snapshot", account_id: "cash", amount_minor: "500", currency_code: "EUR", as_of: "2026-10-01T08:00:00Z", provenance, version: 1 }];
  const db = { from: (table: string) => {
    const rows = table === "accounts" ? accounts : table === "balance_snapshots" ? snapshots : [];
    const query = { select: () => query, eq: () => query, order: () => query, range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }) };
    return query;
  } } as unknown as SupabaseClient;
  const context = { supabase: db, workspace: { id: workspaceId, timezone: "UTC" }, settings: settingsSchema.parse({ ai_data_scopes: ["accounts", "transactions"] }) } as Awaited<ReturnType<typeof requireWorkspace>>;
  const direct = await getBalances(context, false, true);
  const review = buildReviewEvidence(accounts, snapshots, [], "2026-07-04", "2026-10-01", { asOf: now, ledger: [], timeZone: "UTC" });
  for (const [name, result, ids] of [
    ["accounts_getBalances", direct, ["0.balance.snapshot_amount_minor", "0.balance.amount_minor"]],
    ["reviews_investigate", { ...review, accountBalanceTotals: review.netWorth }, ["accounts.0.snapshotBalanceMinor", "accounts.0.balanceMinor", "netWorth.EUR", "accountBalanceTotals.EUR"]],
  ] as const) {
    const receipt = toolResultReceipt(name, {}, result, { workspaceId, fetchedAt: now, timezone: "UTC" }, ["accounts"]);
    expect(receipt.sources[0].record).toEqual(result);
    for (const id of ids) {
      const metric = receipt.metrics.find(metric => metric.id === id)!;
      expect(metric.qualifiers).toContain("dated_snapshot");
      expect(metric.qualifiers.includes("manual_evidence")).toBe(provenance === "manual");
      expect(metric.period).toEqual({ from: "2026-10-01", to: "2026-10-01" });
      const answer = providerFinancialAnswer(JSON.stringify({ claims: [{ operation: "metric", operands: [{ receiptId: receipt.id, metricId: id }], valueMinor: "500", currency: "EUR", periods: [metric.period], qualifiers: metric.qualifiers }], interpretation: [] }), [receipt], workspaceId);
      expect(answer.accepted).toHaveLength(1);
      expect(answer.body.includes("Manual evidence")).toBe(provenance === "manual");
      expect(answer.body).toContain("Dated snapshot");
    }
  }
  expect(direct[0].calculationEvidence.snapshots[0].provenance).toBe(provenance);
});
