import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCalculatorSnapshot } from "./snapshot";
import { goalsForArtifact, spendingForArtifact } from "./finance-sdk";

vi.mock("./finance-sdk", () => ({ goalsForArtifact: vi.fn(), spendingForArtifact: vi.fn(), tripForArtifact: vi.fn() }));

describe("calculator financial snapshots", () => {
  beforeEach(() => vi.resetAllMocks());

  it("preserves a USD goal and exact reservation amounts", async () => {
    vi.mocked(goalsForArtifact).mockResolvedValue({
      currency: "EUR", goals: [{ id: "g", name: "Trip", target_minor: "10000", currency_code: "USD", target_date: null, status: "active" }],
      allocations: [{ goal_id: "g", account_id: "a", amount_minor: "2500" }],
      balances: [{ id: "a", currency_code: "USD" }],
    } as Awaited<ReturnType<typeof goalsForArtifact>>);
    expect((await buildCalculatorSnapshot("a", "goal_tracker")).snapshot).toEqual({ currency: "USD", goals: [
      { id: "g", name: "Trip", currency: "USD", targetMinor: "10000", savedMinor: "2500", remainingMinor: "7500" },
    ] });
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
        { id: "eur", name: "EUR trip", target_minor: "10000", currency_code: "EUR", target_date: null, status: "active" },
        { id: "usd", name: "USD trip", target_minor: "10000", currency_code: "USD", target_date: null, status: "active" },
      ], allocations: [], balances: [],
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
    expect("daily" in snapshot && snapshot.daily).toHaveLength(30);
    if ("daily" in snapshot) {
      expect(snapshot.daily?.[0]).toEqual({ date: "2026-09-01", spendingMinor: "1000" });
      expect(snapshot.daily?.at(-1)).toEqual({ date: "2026-09-30", spendingMinor: "-200" });
      expect(snapshot.daily?.reduce((sum, day) => sum + BigInt(day.spendingMinor), 0n)).toBe(800n);
    }
  });
});
