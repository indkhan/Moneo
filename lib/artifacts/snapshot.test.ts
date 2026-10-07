import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBalances } from "@/lib/finance/balances";
import { fixturesForKind } from "./validate";
import { buildCalculatorSnapshot } from "./snapshot";
import { balancesForArtifact, goalsForArtifact, spendingForArtifact, tripForArtifact } from "./finance-sdk";
import { buildSourceCoverage } from "@/lib/finance/source-coverage";

it("retains source coverage for available and unavailable calculator spending snapshots", async () => {
  const sourceCoverage = buildSourceCoverage({ from: "2026-10-01", to: "2026-10-02" }, []);
  const data = { reporting: undefined, conversionCoverage: undefined, resultBasis: undefined, sourceCoverage: { ...sourceCoverage, scope: { ...sourceCoverage.scope, descriptionFilter: "none", effectiveRowFilter: "all" } }, timezone: "Europe/Berlin", currency: "EUR", from: "2026-10-01", to: "2026-10-02", transactions: [], byAccount: [],
    summary: { incomeMinor: "0", spendingMinor: "0", netMinor: "0", partial: false, excludedReviewRows: 0 } };
  vi.mocked(spendingForArtifact).mockResolvedValue(data as Awaited<ReturnType<typeof spendingForArtifact>>);
  expect((await buildCalculatorSnapshot("a", "spending_explorer")).snapshot).toMatchObject({ sourceCoverage });
  vi.mocked(spendingForArtifact).mockResolvedValue({ ...data, summary: { unavailable: "FX missing" } } as Awaited<ReturnType<typeof spendingForArtifact>>);
  expect((await buildCalculatorSnapshot("a", "spending_explorer")).snapshot).toMatchObject({ unavailable: "FX missing", sourceCoverage });
});

vi.mock("./finance-sdk", () => ({ balancesForArtifact: vi.fn(), goalsForArtifact: vi.fn(), spendingForArtifact: vi.fn(), tripForArtifact: vi.fn() }));

describe("calculator financial snapshots", () => {
  beforeEach(() => vi.resetAllMocks());
  it("loads only declared custom operations and preserves exact money and missing-data reasons", async () => {
    vi.mocked(balancesForArtifact).mockResolvedValue({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-02" }, []), currency: "EUR", balances: [{ id: "a", name: "Cash", currency_code: "EUR", balance: { amount_minor: "9007199254740993", as_of: "2026-10-01T00:00:00Z", status: "current" } }] } as Awaited<ReturnType<typeof balancesForArtifact>>);
    const result = await buildCalculatorSnapshot("a", "custom_comparison", { sdk: ["balances"] });
    expect(result.snapshot).toMatchObject({ balances: [{ balance: { amount_minor: "9007199254740993" } }] });
    expect(spendingForArtifact).not.toHaveBeenCalled(); expect(tripForArtifact).not.toHaveBeenCalled(); expect(goalsForArtifact).not.toHaveBeenCalled();
    vi.mocked(balancesForArtifact).mockRejectedValue(new Error("AI access to accounts is disabled in Settings"));
    expect((await buildCalculatorSnapshot("a", "custom_report", { sdk: ["balances"] })).snapshot).toMatchObject({ unavailable: "balances: AI access to accounts is disabled in Settings" });
    await expect(buildCalculatorSnapshot("a", "custom_report", { sdk: ["raw_source"] })).rejects.toThrow("Unauthorized");
  });

  it("preserves a USD goal and exact reservation amounts", async () => {
    vi.mocked(goalsForArtifact).mockResolvedValue({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-02" }, []), resultBasis: "synthetic accepted evidence",
      currency: "EUR", goals: [{ id: "g", name: "Trip", target_minor: "10000", currency_code: "USD", target_date: null, status: "active" }],
      allocations: [{ goal_id: "g", account_id: "a", amount_minor: "2500" }],
      balances: [{ id: "a", currency_code: "USD" }],
    } as Awaited<ReturnType<typeof goalsForArtifact>>);
    expect((await buildCalculatorSnapshot("a", "goal_tracker")).snapshot).toEqual({ currency: "USD", sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-02" }, []), coverage: { goals: { total: 1, included: 1, truncated: false } }, goals: [
      { id: "g", name: "Trip", currency: "USD", targetMinor: "10000", savedMinor: null, savedAsOf: null, reservedMinor: "2500", remainingMinor: null, reservedRemainingMinor: "7500", plannedMonthlyMinor: "0", contributionStartsOn: null },
    ] });
  });

  it("keeps recorded dated savings independent of virtual reservations", async () => {
    vi.mocked(goalsForArtifact).mockResolvedValue({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-02" }, []), resultBasis: "synthetic accepted evidence", currency: "EUR", goals: [{ id: "g", name: "Trip", target_minor: "10000", currency_code: "EUR", recorded_saved_minor: "3000", saved_as_of: "2026-09-01", planned_monthly_minor: "500", contribution_starts_on: "2026-10-01" }], allocations: [{ goal_id: "g", account_id: "a", amount_minor: "2500" }], balances: [{ id: "a", currency_code: "EUR" }] } as Awaited<ReturnType<typeof goalsForArtifact>>);
    expect((await buildCalculatorSnapshot("a", "goal_tracker")).snapshot).toMatchObject({ goals: [{ savedMinor: "3000", savedAsOf: "2026-09-01", reservedMinor: "2500", remainingMinor: "7000", reservedRemainingMinor: "7500", plannedMonthlyMinor: "500" }] });
  });

  it("does not add a foreign account allocation into the goal currency", async () => {
    vi.mocked(goalsForArtifact).mockResolvedValue({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-02" }, []), resultBasis: "synthetic accepted evidence",
      currency: "EUR", goals: [{ id: "g", name: "Trip", target_minor: "10000", currency_code: "USD", target_date: null, status: "active" }],
      allocations: [{ goal_id: "g", account_id: "a", amount_minor: "2500" }], balances: [{ id: "a", currency_code: "EUR" }],
    } as Awaited<ReturnType<typeof goalsForArtifact>>);
    expect((await buildCalculatorSnapshot("a", "goal_tracker")).snapshot).toMatchObject({
      goals: [], unavailable: "Goal allocations require currency conversion",
    });
  });

  it("does not apply one monthly contribution currency to differently denominated goals", async () => {
    vi.mocked(goalsForArtifact).mockResolvedValue({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-02" }, []), resultBasis: "synthetic accepted evidence",
      currency: "EUR", goals: [
        { id: "eur", name: "EUR trip", target_minor: "10000", currency_code: "EUR", target_date: null, status: "active", recorded_saved_minor: "0", saved_as_of: null, planned_monthly_minor: "0", contribution_starts_on: null },
        { id: "usd", name: "USD trip", target_minor: "10000", currency_code: "USD", target_date: null, status: "active", recorded_saved_minor: "0", saved_as_of: null, planned_monthly_minor: "0", contribution_starts_on: null },
      ], allocations: [], balances: [], timezone: "Europe/Berlin",
    });
    expect((await buildCalculatorSnapshot("a", "goal_tracker")).snapshot).toMatchObject({
      currency: "EUR", goals: [], unavailable: "Goals use different currencies; choose a single currency before comparing saving pace",
    });
  });

  it("uses refunds and every day in the spending period", async () => {
    vi.mocked(spendingForArtifact).mockResolvedValue({
      currency: "EUR", from: "2026-09-01", to: "2026-09-30",
      summary: { incomeMinor: "0", spendingMinor: "800", netMinor: "-800" },
      byAccount: [{ id: "cash", incomeMinor: "0", spendingMinor: "800", netMinor: "-800", partial: false, excludedReviewRows: 0 }],
      transactions: [
        { posted_on: "2026-09-01", amount_minor: "-1000", kind: "ordinary" },
        { posted_on: "2026-09-30", amount_minor: "200", kind: "refund" },
      ],
    } as Awaited<ReturnType<typeof spendingForArtifact>>);
    const snapshot = (await buildCalculatorSnapshot("a", "spending_explorer")).snapshot;
    expect(snapshot).toMatchObject({ from: "2026-09-01", to: "2026-09-30", byAccount: [{ id: "cash", spendingMinor: "800" }] });
    expect("daily" in snapshot && snapshot.daily).toHaveLength(30);
    if ("daily" in snapshot) {
      expect(snapshot.daily?.[0]).toEqual({ date: "2026-09-01", spendingMinor: "1000" });
      expect(snapshot.daily?.at(-1)).toEqual({ date: "2026-09-30", spendingMinor: "-200" });
      expect(snapshot.daily?.reduce((sum, day) => sum + BigInt(day.spendingMinor), 0n)).toBe(800n);
    }
  });
});


it("discloses capped balances and goals without losing exact totals", async () => {
  vi.mocked(balancesForArtifact).mockResolvedValue({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-02" }, []), currency: "EUR", balances: resolveBalances(Array.from({length: 51}, (_, i) => ({ id: String(i), name: "Synthetic", currency_code: "EUR" })), [], [], "2026-10-01T00:00:00Z") } as Awaited<ReturnType<typeof balancesForArtifact>>);
  const balances = (await buildCalculatorSnapshot("a", "custom_report", {sdk: ["balances"]})).snapshot;
  expect(balances).toMatchObject({ coverage: { balances: { total: 51, included: 50, truncated: true } } });
  expect("balances" in balances && balances.balances).toHaveLength(50);
  vi.mocked(goalsForArtifact).mockResolvedValue({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-02" }, []), resultBasis: "synthetic accepted evidence",currency: "EUR", goals: Array.from({length: 21}, (_, i) => ({id: String(i), name: "Synthetic", target_minor: "10000", currency_code: "EUR", recorded_saved_minor: "0", saved_as_of: null, target_date: null, status: "active", planned_monthly_minor: "0", contribution_starts_on: null})), allocations: [], balances: [], timezone: "Europe/Berlin"} as Awaited<ReturnType<typeof goalsForArtifact>>);
  const goals = (await buildCalculatorSnapshot("a", "custom_report", {sdk: ["goals"]})).snapshot;
  expect(goals).toMatchObject({coverage: {goals: {total: 21, included: 20, truncated: true}}});
  expect("goals" in goals && goals.goals).toHaveLength(20);
});


it("keeps normal fixtures identical to host snapshots for all 32 SDK subsets", async () => {
  const operations = ["spending", "cashflow", "balances", "goals", "forecast"];
  const fixture = fixturesForKind("custom_report", operations)[0].snapshot as { sourceCoverageByOperation: Record<string, ReturnType<typeof buildSourceCoverage>>; currency: string; balances: Awaited<ReturnType<typeof balancesForArtifact>>["balances"]; spending: {from: string; to: string; incomeMinor: string; spendingMinor: string; netMinor: string; partial: boolean; excludedReviewRows: number; byAccount: Awaited<ReturnType<typeof spendingForArtifact>>["byAccount"]} };
  vi.mocked(balancesForArtifact).mockResolvedValue({ sourceCoverage: fixture.sourceCoverageByOperation.balances,currency: fixture.currency, balances: fixture.balances});
  vi.mocked(spendingForArtifact).mockResolvedValue({ sourceCoverage: fixture.sourceCoverageByOperation.spending, currency: fixture.currency, from: fixture.spending.from, to: fixture.spending.to, summary: {incomeMinor: fixture.spending.incomeMinor, spendingMinor: fixture.spending.spendingMinor, netMinor: fixture.spending.netMinor, partial: false, excludedReviewRows: 0}, byAccount: fixture.spending.byAccount, transactions: [{posted_on: "2026-09-01", amount_minor: "-80000", kind: "ordinary"}] } as Awaited<ReturnType<typeof spendingForArtifact>>);
  vi.mocked(goalsForArtifact).mockResolvedValue({ sourceCoverage: fixture.sourceCoverageByOperation.goals, resultBasis: "synthetic accepted evidence",currency: "EUR", timezone: "Europe/Berlin", goals: [{id: "g", name: "Synthetic goal", currency_code: "EUR", target_minor: "10000", recorded_saved_minor: "2500", saved_as_of: "2026-09-01", planned_monthly_minor: "500", contribution_starts_on: null}], allocations: [{goal_id: "g", account_id: "a", amount_minor: "1000"}], balances: fixture.balances} as Awaited<ReturnType<typeof goalsForArtifact>>);
  vi.mocked(tripForArtifact).mockResolvedValue({ sourceCoverage: fixture.sourceCoverageByOperation.forecast, resultBasis: "synthetic accepted evidence",currency: "EUR", baseline: {status: "available", amountMinor: 150000n}, withTrip: {status: "available", amountMinor: 60000n}, unavailable: null, tripDate: "2026-10-03"} as Awaited<ReturnType<typeof tripForArtifact>>);
  for (let mask = 0; mask < 32; mask++) {
    const sdk = operations.filter((_, index) => mask & (1 << index));
    expect((await buildCalculatorSnapshot("synthetic", "custom_report", {sdk})).snapshot, sdk.join(",")).toEqual(fixturesForKind("custom_report", sdk)[0].snapshot);
  }
});
