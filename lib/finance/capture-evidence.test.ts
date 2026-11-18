import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiScopeGuard, DEFAULT_SETTINGS, type WorkspaceSettings } from "@/lib/workspace-settings";
import type { GuardedFinanceContext } from "./finance-context";
import { captureToolEvidence } from "./capture-evidence";
import { investigationSchema, type InvestigationRow } from "./investigation";
import { defined } from "@/lib/testing";
const fixture = vi.hoisted(() => ({ dataset: vi.fn(), balances: vi.fn() }));
vi.mock("./investigation-reader", async original => ({ ...await original<typeof import("./investigation-reader")>(), loadInvestigationDataset: fixture.dataset }));
vi.mock("./tools", async original => ({ ...await original<typeof import("./tools")>(), getBalances: fixture.balances }));
const guarded = (settings: WorkspaceSettings) => ({ workspace: { id: "00000000-0000-4000-8000-000000000001", display_currency: "EUR", timezone: "UTC" }, settings, requireScopes: aiScopeGuard(settings) }) as unknown as GuardedFinanceContext;
const context = guarded(DEFAULT_SETTINGS);
it("retains owned ordinary query inputs, exact results and capture scopes before publication", async () => {
  const insert = vi.fn(async () => ({ error: null }));
  const service = { from: () => ({ insert }) } as unknown as SupabaseClient;
  const result = { from: "2026-09-01", to: "2026-09-30", currencyCode: "EUR", spendingMinor: "25" };
  const receipts = await captureToolEvidence("analytics_cashflow", { from: result.from, to: result.to, currencyCode: "EUR" }, result, context, service);
  expect(receipts).toHaveLength(1);
  expect(defined(receipts[0]).query.result).toEqual(result);
  expect(defined(receipts[0]).scopes).toEqual(["transactions", "imports"]);
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: context.workspace.id }));
});
it("does not persist or expose newly revoked scopes", async () => {
  const insert = vi.fn();
  await expect(captureToolEvidence("analytics_cashflow", {}, {}, guarded({ ...DEFAULT_SETTINGS, ai_data_scopes: [] }), { from: () => ({ insert }) } as unknown as SupabaseClient)).rejects.toThrow(/disabled/);
  expect(insert).not.toHaveBeenCalled();
});
it.each(["planning", "imports"] as const)("rejects revocation of actually read optional %s scope before receipt capture", async revoked => {
  const insert = vi.fn(async () => ({ error: null }));
  const latest = guarded({ ...DEFAULT_SETTINGS, ai_data_scopes: DEFAULT_SETTINGS.ai_data_scopes.filter(scope => scope !== revoked) });
  const capture = captureToolEvidence as unknown as (...args: unknown[]) => Promise<unknown>;
  await expect(capture("reviews_investigate", {}, { planning: { secret: "Synthetic optional result" }, sourceCoverage: { imports: "Synthetic read" } }, latest, { from: () => ({ insert }) }, ["accounts", "transactions", "planning", "imports"])).rejects.toThrow(new RegExp(revoked));
  expect(insert).not.toHaveBeenCalled();
});
it("captures exact full investigation support rather than the first tool display page", async () => {
  const row: InvestigationRow = { id: "00000000-0000-4000-8000-000000000002", parentId: "00000000-0000-4000-8000-000000000002", accountId: "owned", categoryId: null, merchantId: null, date: "2026-09-01", amountMinor: "-10", currency: "EUR", status: "posted", kind: "ordinary", tags: [], event: null, reviewReasons: [], version: 1, description: "Synthetic" };
  const spec = investigationSchema.parse({ version: 1, period: { from: "2026-09-01", to: "2026-09-30" } });
  fixture.dataset.mockResolvedValue({ spec, rows: [row], context: { workspaceId: context.workspace.id, capturedAt: "2026-10-01T00:00:00Z" }, sourceRevision: "v1" });
  const service = { from: () => ({ insert: async () => ({ error: null }) }) } as unknown as SupabaseClient;
  const receipts = await captureToolEvidence("finance_investigate", spec, { groups: [] }, context, service);
  expect(defined(receipts[0]).metrics[0]).toMatchObject({ valueMinor: "10", sourceIds: [row.id] });
  expect(defined(defined(receipts[0]).sources[0]).record).toMatchObject({ id: row.id, parentId: row.parentId });
  const scenario = await captureToolEvidence("finance_scenario", { query: spec, overrides: [{ id: row.id, amountMinor: "-30" }] }, {}, context, service);
  expect(scenario).toHaveLength(2);
  expect(defined(scenario[1]).metrics[0]).toMatchObject({ valueMinor: "30", qualifiers: ["assumption"] });
  expect(defined(defined(scenario[0]).sources[0]).record).toMatchObject({ amountMinor: "-10" });
});
it("retains account calculation source records without returning those private rows as provider tool output", async () => {
  const supported = [{ id: "00000000-0000-4000-8000-000000000002", currency_code: "EUR", balance: { amount_minor: "10", evaluated_at: "2026-10-01T00:00:00Z" }, calculationEvidence: { snapshots: [{ amount_minor: "20" }], ledger: [{ amount_minor: "-10" }] } }];
  fixture.balances.mockResolvedValue(supported);
  const original = [{ id: defined(supported[0]).id, currency_code: "EUR", balance: { amount_minor: "9" } }];
  const receipts = await captureToolEvidence("accounts_getBalances", {}, original, context, { from: () => ({ insert: async () => ({ error: null }) }) } as unknown as SupabaseClient);
  expect(fixture.balances).toHaveBeenCalledWith(context, true, true);
  expect(defined(defined(receipts[0]).sources[0]).record).toEqual(supported);
  expect(defined(receipts[0]).metrics[0]).toMatchObject({ valueMinor: "10" });
  expect(defined(original[0]).balance.amount_minor).toBe("9");
});
it("preserves conversion blockers in both baseline and hypothetical scenario receipts", async () => {
  const id = "00000000-0000-4000-8000-000000000002";
  const spec = investigationSchema.parse({ version: 1, period: { from: "2026-09-01", to: "2026-09-30" }, currencyPolicy: { mode: "base", currency: "EUR" } });
  fixture.dataset.mockResolvedValue({ spec, rows: [{ id, parentId: id, accountId: "owned", categoryId: null, merchantId: null, date: "2026-09-01", amountMinor: "-10", currency: "USD", status: "posted", kind: "ordinary", tags: [], event: null, reviewReasons: [], version: 1, description: "Synthetic" }], context: { workspaceId: context.workspace.id, capturedAt: "2026-10-01T00:00:00Z" }, sourceRevision: "v1" });
  const service = { from: () => ({ insert: async () => ({ error: null }) }) } as unknown as SupabaseClient;
  const receipts = await captureToolEvidence("finance_scenario", { query: spec, overrides: [{ id, amountMinor: "-30" }] }, {}, context, service);
  for (const receipt of receipts) expect(receipt.limitations).toContainEqual(expect.objectContaining({ kind: "unavailable", message: expect.stringContaining("missing-rate") }));
});
