import { afterEach, expect, it, vi } from "vitest";
import { evaluatePlanForWorkspace } from "./model";
import { coveredTransaction, type BalanceTransaction } from "./balances";
afterEach(() => vi.useRealTimers());
it("funds forecast from reviewed cash with later postings, pending holds and reservations consumed once", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-06T14:00:00Z"));
  const account = { id: "00000000-0000-4000-8000-000000000001", name: "Synthetic reviewed cash", currency_code: "EUR", type: "checking" };
  const morning: BalanceTransaction = { id: "morning", account_id: account.id, amount_minor: "-100", currency_code: "EUR", posted_on: "2026-10-06", posted_at: "2026-10-06T08:00:00Z", status: "posted", version: 0 };
  const evidence = { accounts: [account], snapshots: [{ id: "review", account_id: account.id, amount_minor: "10000", currency_code: "EUR", as_of: "2026-10-06T12:00:00Z", provenance: "manual", boundary_kind: "reviewed_activity", covered_transactions: [coveredTransaction(morning)] }],
    ledger: [morning, { ...morning, id: "later", amount_minor: "-250", posted_at: "2026-10-06T13:00:00Z" }, { ...morning, id: "pending", amount_minor: "-1000", status: "pending" }], asOf: "2026-10-06T14:00:00Z" };
  const from = (table: string) => {
    const data = table === "goal_allocations" ? [{ account_id: account.id, amount_minor: "100" }] : [];
    const query = { select: () => query, eq: () => query, is: () => query, order: () => query, maybeSingle: async () => ({ data: null, error: null }),
      range: async () => ({ data, error: null }), then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve) };
    return query;
  };
  const result = await evaluatePlanForWorkspace({ from } as unknown as Parameters<typeof evaluatePlanForWorkspace>[0],
    { id: "synthetic", display_currency: "EUR", timezone: "Europe/Berlin" }, 2, undefined,
    { balanceEvidence: Promise.resolve({ ...evidence, ledger: evidence.ledger.map(row => ({ ...row, source_transaction_ids: [] })) }), wealth: Promise.resolve([]) });
  expect(result.input.accounts[0].balanceMinor).toBe(9750n);
  expect(result.available).toMatchObject({ status: "available", amountMinor: 8650n });
});

it.each(["0", "500", "2000"])("deducts only the pending remainder after a %s minor-unit release", async released => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
  const account = { id: "checking", name: "Synthetic", currency_code: "EUR", type: "checking" };
  const ledger = [{ id: "hold", account_id: account.id, amount_minor: "-2000", currency_code: "EUR", posted_on: "2026-10-05", status: "pending", pending_released_minor: released },
    { id: "settlement", account_id: account.id, amount_minor: "-2000", currency_code: "EUR", posted_on: "2026-10-06", status: "posted" }];
  const from = () => {
    const query = { select: () => query, eq: () => query, is: () => query, order: () => query, maybeSingle: async () => ({ data: null, error: null }),
      range: async () => ({ data: [], error: null }), then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve) };
    return query;
  };
  const result = await evaluatePlanForWorkspace({ from } as unknown as Parameters<typeof evaluatePlanForWorkspace>[0],
    { id: "synthetic", display_currency: "EUR", timezone: "Europe/Berlin" }, 2, undefined,
    { balanceEvidence: Promise.resolve({ accounts: [account], ledger, snapshots: [{ account_id: account.id, amount_minor: "8000", currency_code: "EUR", as_of: "2026-10-07T10:00:00Z", provenance: "manual", boundary_kind: "reviewed_activity", covered_transactions: [] }], asOf: "2026-10-07T12:00:00Z" }), wealth: Promise.resolve([]) });
  expect(result.input.accounts[0].pendingHoldMinor).toBe(2000n - BigInt(released));
  expect(result.available).toMatchObject({ status: "available", amountMinor: 6000n + BigInt(released) });
});
