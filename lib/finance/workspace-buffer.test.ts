import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluatePlanForWorkspace } from "./model";
import { accountLiquidity, withInternalFunding, type ForecastInput } from "./calculations";
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));

it.each([false, true])("loads workspace buffer without inventing account ownership (reversed=%s)", async reverse => {
  const accounts = [{ id: "empty", name: "Empty", type: "checking", currency_code: "EUR" }, { id: "funded", name: "Funded", type: "savings", currency_code: "EUR" }];
  if (reverse) accounts.reverse();
  const db = { from: (table: string) => {
    const query = { select: () => query, in: () => query, eq: () => query, is: () => query, order: () => query, range: async () => ({ data: [], error: null }),
      maybeSingle: async () => ({ data: table === "forecast_preferences" ? { currency_code: "EUR", safety_buffer_minor: "10000", daily_spending_minor: "0", uncertainty_bps: 0, spending_account_id: null, spending_starts_on: null } : null, error: null }) };
    return query;
  } } as unknown as SupabaseClient;
  const result = await evaluatePlanForWorkspace(db, { id: "synthetic", display_currency: "EUR", timezone: "UTC" }, 2, undefined, {
    wealth: Promise.resolve([]), balanceEvidence: Promise.resolve({ accounts, snapshots: accounts.map(account => ({ account_id: account.id, amount_minor: account.id === "empty" ? "0" : "100000", currency_code: "EUR", as_of: "2026-10-07T12:00:00Z", provenance: "manual" })), ledger: [], asOf: "2026-10-07T12:00:00Z" }),
  });
  expect(result.input.workspaceBufferMinor).toBe(10000n);
  expect(result.input.accounts.every(account => !account.safetyBufferMinor)).toBe(true);
  expect(result.liquidity).toMatchObject({ aggregate: { amountMinor: 90000n }, workspaceBufferMinor: 10000n, hasShortfall: false });
  if (result.liquidity.status !== "available") throw new Error("Expected available");
  expect(result.liquidity.accounts.find(account => account.accountId === "empty")).toMatchObject({ amountMinor: 0n, protectedMinor: 0n, shortfallMinor: 0n, spendableMinor: 0n });
  expect(result.liquidity.accounts.find(account => account.accountId === "funded")).toMatchObject({ amountMinor: 100000n, spendableMinor: 90000n });
});
it("keeps global pressure distinct from local gaps, and paired funding cannot restore protected workspace cash", () => {
  const input: ForecastInput = { startDate: "2026-10-07", horizonDays: 3, currencyCode: "EUR", workspaceBufferMinor: 10000n,
    accounts: [{ id: "empty", currencyCode: "EUR", balanceMinor: 0n }, { id: "donor", currencyCode: "EUR", balanceMinor: 100000n, reservedMinor: 95000n }], events: [] };
  const result = accountLiquidity(withInternalFunding(input, [{ date: input.startDate, currencyCode: "EUR", fromAccountId: "donor", toAccountId: "empty", amountMinor: 1000n }]));
  expect(result).toMatchObject({ aggregate: { amountMinor: -5000n }, workspaceBufferPressureMinor: 5000n, hasShortfall: true,
    accounts: [{ accountId: "empty", amountMinor: 1000n, shortfallMinor: 0n, spendableMinor: -5000n }, { accountId: "donor", shortfallMinor: 0n }],
  });
});
it("preserves the global cap's actual limiting date separately from the account's liquidity date", () => {
  const result = accountLiquidity({ startDate: "2026-10-07", horizonDays: 3, currencyCode: "EUR", workspaceBufferMinor: 10000n,
    accounts: [{ id: "chosen", currencyCode: "EUR", balanceMinor: 100000n }, { id: "other", currencyCode: "EUR", balanceMinor: 10000n }],
    events: [{ date: "2026-10-08", accountId: "other", expectedMinor: -10000n }] });
  expect(result).toMatchObject({ accounts: [ { accountId: "chosen", limitingDate: "2026-10-07", spendableMinor: 90000n, spendingLimitingDate: "2026-10-08" }, { accountId: "other" } ] });
});
