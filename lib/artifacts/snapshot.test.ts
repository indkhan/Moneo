import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCalculatorSnapshot } from "./snapshot";
import { balancesForArtifact, goalsForArtifact, spendingForArtifact, tripForArtifact } from "./finance-sdk";

vi.mock("./finance-sdk", () => ({ balancesForArtifact: vi.fn(), goalsForArtifact: vi.fn(), spendingForArtifact: vi.fn(), tripForArtifact: vi.fn() }));

describe("calculator financial snapshots", () => {
  beforeEach(() => vi.resetAllMocks());
  it("loads only declared custom operations and preserves exact money and missing-data reasons", async () => {
    vi.mocked(balancesForArtifact).mockResolvedValue({ currency: "EUR", balances: [{ id: "a", name: "Cash", currency_code: "EUR", balance: { amount_minor: "9007199254740993", as_of: "2026-10-01T00:00:00Z", status: "current" } }] } as Awaited<ReturnType<typeof balancesForArtifact>>);
    const result = await buildCalculatorSnapshot("a", "custom_comparison", { sdk: ["balances"] });
    expect(result.snapshot).toMatchObject({ balances: [{ balance: { amount_minor: "9007199254740993" } }] });
    expect(spendingForArtifact).not.toHaveBeenCalled(); expect(tripForArtifact).not.toHaveBeenCalled(); expect(goalsForArtifact).not.toHaveBeenCalled();
    vi.mocked(balancesForArtifact).mockRejectedValue(new Error("AI access to accounts is disabled in Settings"));
    expect((await buildCalculatorSnapshot("a", "custom_report", { sdk: ["balances"] })).snapshot).toMatchObject({ unavailable: "balances: AI access to accounts is disabled in Settings" });
    await expect(buildCalculatorSnapshot("a", "custom_report", { sdk: ["raw_source"] })).rejects.toThrow("Unauthorized");
  });

  it("preserves a USD goal and exact reservation amounts", async () => {
    vi.mocked(goalsForArtifact).mockResolvedValue({
      currency: "EUR", goals: [{ id: "g", name: "Trip", target_minor: "10000", currency_code: "USD", target_date: null, status: "active" }],
      allocations: [{ goal_id: "g", account_id: "a", amount_minor: "2500" }],
      balances: [{ id: "a", currency_code: "USD" }],
    } as Awaited<ReturnType<typeof goalsForArtifact>>);
    expect((await buildCalculatorSnapshot("a", "goal_tracker")).snapshot).toEqual({ currency: "USD", goals: [
      { id: "g", name: "Trip", currency: "USD", targetMinor: "10000", savedMinor: null, savedAsOf: null, reservedMinor: "2500", remainingMinor: null, reservedRemainingMinor: "7500", plannedMonthlyMinor: "0", contributionStartsOn: null },
    ] });
  });

  it("keeps recorded dated savings independent of virtual reservations", async () => {
    vi.mocked(goalsForArtifact).mockResolvedValue({ currency: "EUR", goals: [{ id: "g", name: "Trip", target_minor: "10000", currency_code: "EUR", recorded_saved_minor: "3000", saved_as_of: "2026-09-01", planned_monthly_minor: "500", contribution_starts_on: "2026-10-01" }], allocations: [{ goal_id: "g", account_id: "a", amount_minor: "2500" }], balances: [{ id: "a", currency_code: "EUR" }] } as Awaited<ReturnType<typeof goalsForArtifact>>);
    expect((await buildCalculatorSnapshot("a", "goal_tracker")).snapshot).toMatchObject({ goals: [{ savedMinor: "3000", savedAsOf: "2026-09-01", reservedMinor: "2500", remainingMinor: "7000", reservedRemainingMinor: "7500", plannedMonthlyMinor: "500" }] });
  });

  it("does not add a foreign account allocation into the goal currency", async () => {
    vi.mocked(goalsForArtifact).mockResolvedValue({
      currency: "EUR", goals: [{ id: "g", name: "Trip", target_minor: "10000", currency_code: "USD", target_date: null, status: "active" }],
      allocations: [{ goal_id: "g", account_id: "a", amount_minor: "2500" }], balances: [{ id: "a", currency_code: "EUR" }],
    } as Awaited<ReturnType<typeof goalsForArtifact>>);
    expect((await buildCalculatorSnapshot("a", "goal_tracker")).snapshot).toMatchObject({
      goals: [], unavailable: "Goal allocations require currency conversion",
    });
  });

  it("does not apply one monthly contribution currency to differently denominated goals", async () => {
    vi.mocked(goalsForArtifact).mockResolvedValue({
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
      transactions: [
        { posted_on: "2026-09-01", amount_minor: "-1000", kind: "ordinary" },
        { posted_on: "2026-09-30", amount_minor: "200", kind: "refund" },
      ],
    } as Awaited<ReturnType<typeof spendingForArtifact>>);
    const snapshot = (await buildCalculatorSnapshot("a", "spending_explorer")).snapshot;
    expect(snapshot).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect("daily" in snapshot && snapshot.daily).toHaveLength(30);
    if ("daily" in snapshot) {
      expect(snapshot.daily?.[0]).toEqual({ date: "2026-09-01", spendingMinor: "1000" });
      expect(snapshot.daily?.at(-1)).toEqual({ date: "2026-09-30", spendingMinor: "-200" });
      expect(snapshot.daily?.reduce((sum, day) => sum + BigInt(day.spendingMinor), 0n)).toBe(800n);
    }
  });
});
