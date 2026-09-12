import { describe, expect, it } from "vitest";
import {
  balancePreviewQuerySchema,
  handlePreviewBalance,
  type BalancePreviewStore,
} from "./balance-preview";

/**
 * Issue 4.10 — balance preview handler unit-tests without Postgres.
 *
 * Proves the read-only boundary: 401 without a workspace, 404 for foreign
 * accounts, query validation before any store call, and the shared preview
 * math projected verbatim (exact roll-forward, honest unresolved reasons).
 */

const WID = "11111111-1111-7111-8111-111111111111";
const AID = "22222222-2222-7222-8222-222222222222";

function store(
  overrides: Partial<BalancePreviewStore> = {},
): BalancePreviewStore & { calls: number } {
  const state = {
    calls: 0,
    findAccount: () => Promise.resolve({ id: AID, currencyCode: "EUR" }),
    listTransactions: () =>
      Promise.resolve({
        items: [
          {
            id: "t1",
            effectiveDate: "2026-08-16",
            direction: "debit" as const,
            amountMinor: "1550",
            currencyCode: "EUR",
          },
          {
            id: "t2",
            effectiveDate: "2026-08-17",
            direction: "credit" as const,
            amountMinor: "200000",
            currencyCode: "EUR",
          },
        ],
        truncated: false,
      }),
    ...overrides,
  };
  const counting: BalancePreviewStore & { calls: number } = {
    calls: 0,
    findAccount: (...args) => ((counting.calls += 1), state.findAccount(...args)),
    listTransactions: (...args) => ((counting.calls += 1), state.listTransactions(...args)),
  };
  return counting;
}

const QUERY = "?currentAmountMinor=10000&currencyCode=EUR&cutoffDate=2026-08-15";

describe("handlePreviewBalance", () => {
  it("answers 401 without a workspace and never touches the store", async () => {
    const ctx = store();
    const res = await handlePreviewBalance(AID, QUERY, { workspaceId: undefined, preview: ctx });
    expect(res.status).toBe(401);
    expect(ctx.calls).toBe(0);
  });

  it("projects the proposed snapshot over later transactions", async () => {
    const res = await handlePreviewBalance(AID, QUERY, { workspaceId: WID, preview: store() });
    expect(res.status).toBe(200);
    // 10000 − 1550 + 200000 = 208450.
    expect(await res.json()).toEqual({
      applicableCount: 2,
      skippedCrossCurrency: 0,
      projectedCurrentMinor: "208450",
      unresolved: false,
      reason: null,
      truncated: false,
    });
  });

  it("answers 404 for foreign accounts and 400 for malformed queries", async () => {
    const missing = await handlePreviewBalance(AID, QUERY, {
      workspaceId: WID,
      preview: store({ findAccount: () => Promise.resolve(null) }),
    });
    expect(missing.status).toBe(404);

    const ctx = store();
    for (const bad of [
      "?currencyCode=EUR",
      "?currentAmountMinor=10.00&currencyCode=EUR",
      "?currentAmountMinor=100&currencyCode=EURO",
    ]) {
      const res = await handlePreviewBalance(AID, bad, { workspaceId: WID, preview: ctx });
      expect(res.status).toBe(400);
    }
    // Currency mismatch with the account fails closed, never converts.
    const mismatch = await handlePreviewBalance(AID, "?currentAmountMinor=100&currencyCode=JPY", {
      workspaceId: WID,
      preview: ctx,
    });
    expect(mismatch.status).toBe(400);
  });

  it("surfaces unresolved reasons from the shared math", async () => {
    const noCutoff = await handlePreviewBalance(AID, "?currentAmountMinor=100&currencyCode=EUR", {
      workspaceId: WID,
      preview: store(),
    });
    expect(await noCutoff.json()).toMatchObject({ unresolved: true, reason: "no-cutoff" });
  });
});

describe("balancePreviewQuerySchema", () => {
  it("accepts signed amounts and optional null cutoffs", () => {
    expect(
      balancePreviewQuerySchema.safeParse({ currentAmountMinor: "-500", currencyCode: "EUR" })
        .success,
    ).toBe(true);
  });
});
