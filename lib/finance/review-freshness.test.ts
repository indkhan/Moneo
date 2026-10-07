import { expect, it, vi } from "vitest";
import { compareReviewEvidence, reviewFreshness } from "./review-freshness";
import { settingsSchema } from "@/lib/settings";
import type { SupabaseClient } from "@supabase/supabase-js";

const fixture = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./review-loader", () => ({ loadFinancialReviewEvidence: fixture.load }));
const evidence = { period: { from: "2026-07-05", to: "2026-10-02" }, accounts: [{ balanceMinor: "9007199254740993", evaluatedAt: "2026-10-02T10:00:00Z", asOf: "2026-10-02T09:00:00Z" }], planning: { goals: [{ targetMinor: "10000", targetDate: "2026-12-01" }] } };

it("ignores evaluation-clock and object-key order changes but preserves exact dated financial facts", () => {
  expect(compareReviewEvidence(evidence, { planning: evidence.planning, accounts: [{ asOf: evidence.accounts[0].asOf, evaluatedAt: "2026-10-02T11:00:00Z", balanceMinor: "9007199254740993" }], period: evidence.period }).status).toBe("current");
  for (const changed of [
    { ...evidence, accounts: [{ ...evidence.accounts[0], balanceMinor: "9007199254740992" }] },
    { ...evidence, accounts: [{ ...evidence.accounts[0], asOf: "2026-10-01T09:00:00Z" }] },
    { ...evidence, period: { ...evidence.period, to: "2026-10-03" } },
    { ...evidence, planning: { goals: [{ targetMinor: "10000", targetDate: "2027-01-01" }] } },
  ]) expect(compareReviewEvidence(evidence, changed).status).toBe("stale");
  expect(compareReviewEvidence(null, evidence).status).toBe("unknown");
});

it("cannot claim freshness or read financial evidence when current scopes are revoked", async () => {
  fixture.load.mockClear();
  const result = await reviewFreshness({} as SupabaseClient, { id: "w", display_currency: "EUR", timezone: "Europe/Berlin" }, evidence, settingsSchema.parse({ ai_data_scopes: [] }));
  expect(result.status).toBe("unknown");
  expect(fixture.load).not.toHaveBeenCalled();
});

it("compares verified snapshots without capture metadata while detecting source revisions", () => {
  const saved = { ...evidence, verification: { version: 1, receiptIds: ["original"] }, queryInvestigation: { sourceRevision: "v1", evidence: { capturedAt: "2026-10-02T10:00:00Z" } } };
  const current = { ...evidence, calculationEvidence: { retained: true }, queryInvestigation: { sourceRevision: "v1", evidence: { capturedAt: "2026-10-02T11:00:00Z" } } };
  expect(compareReviewEvidence(saved, current).status).toBe("current");
  expect(compareReviewEvidence(saved, { ...current, queryInvestigation: { ...current.queryInvestigation, sourceRevision: "v2" } }).status).toBe("stale");
});

it("preserves a historical review with unknown freshness when settings cannot be loaded", async () => {
  const result = await reviewFreshness({ from: () => { throw new Error("database unavailable"); } } as unknown as SupabaseClient, { id: "w", display_currency: "EUR", timezone: "Europe/Berlin" }, evidence);
  expect(result.status).toBe("unknown");
});
