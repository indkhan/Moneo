import { describe, expect, it } from "vitest";
import { loadBalanceEvidence, resolveBalances } from "./balances";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calendarDate, calendarDayBoundary, reviewedLocalTimestamp } from "./calendar";

const accounts = [{ id: "cash", name: "Cash", currency_code: "EUR" }];
const snapshot = { id: "snapshot", account_id: "cash", amount_minor: "10000", currency_code: "EUR", as_of: "2026-09-28T12:00:00Z", provenance: "manual" };
const transaction = { id: "transaction", account_id: "cash", amount_minor: "-1250", currency_code: "EUR", posted_on: "2026-09-29", status: "posted" };
const now = "2026-10-01T12:00:00Z";

it("loads active additional fees exactly once while retaining canonical source boundaries", async () => {
  const dated = { ...snapshot, as_of: "2026-10-01T08:00:00Z", boundary_kind: "after_transaction", source_transaction_id: "source" };
  const canonical = [
    { ...transaction, posted_at: dated.as_of, posted_on: "2026-10-01", transaction_sources: [{ source_transaction_id: "source" }] },
    { ...transaction, id: "later", posted_at: "2026-10-01T10:00:00Z", posted_on: "2026-10-01" },
  ];
  const tables: Record<string, unknown[]> = { accounts, balance_snapshots: [dated], transactions: canonical,
    transaction_link_fees: [
      { transaction_id: "transaction", fee_minor: "100", treatment: "additional", transaction_links: { undone_at: null } },
      { transaction_id: "later", fee_minor: "25", treatment: "additional", transaction_links: { undone_at: null } },
      { transaction_id: "later", fee_minor: "500", treatment: "included", transaction_links: { undone_at: null } },
      { transaction_id: "later", fee_minor: "500", treatment: "additional", transaction_links: { undone_at: "2026-10-01" } },
    ] };
  const from = (table: string) => {
    const query = { select: () => query, eq: () => query, order: () => query, range: async () => ({ data: tables[table], error: null }) };
    return query;
  };
  const evidence = await loadBalanceEvidence({ from } as unknown as SupabaseClient, "workspace", now);
  expect(evidence.ledger.map(row => row.amount_minor)).toEqual(["-1350", "-1275"]);
  expect(canonical[0].amount_minor).toBe("-1250");
  expect(evidence.ledger[0].source_transaction_ids).toEqual(["source"]);
  expect(resolveBalances(evidence.accounts, evidence.snapshots, evidence.ledger, now)[0].balance)
    .toMatchObject({ amount_minor: "8725", status: "current", reconciled_rows: 1 });
});

describe("evidenced account balances", () => {
  it("reconciles same-day activity only across a preserved after-transaction boundary", () => {
    const dated = { ...snapshot, as_of: "2026-10-01T08:00:00Z", boundary_kind: "after_transaction", source_transaction_id: "source" };
    const included = { ...transaction, posted_on: "2026-10-01", posted_at: dated.as_of, source_transaction_ids: ["source"] };
    const later = { ...transaction, id: "later", posted_on: "2026-10-01", posted_at: "2026-10-01T10:00:00Z" };
    expect(resolveBalances(accounts, [dated], [included, later], now)[0].balance).toMatchObject({ amount_minor: "8750", reconciled_rows: 1, status: "current" });
    expect(resolveBalances(accounts, [dated], [included, { ...later, posted_at: dated.as_of }], now)[0].balance?.status).toBe("ambiguous");
  });
  it("keeps old snapshots stale and reconciles only later posted dates", () => {
    const [balance] = resolveBalances(accounts, [snapshot], [transaction,
      { ...transaction, id: "pending", status: "pending", amount_minor: "-500" },
      { ...transaction, id: "future", posted_on: "2026-10-02", amount_minor: "100000" }], now);
    expect(balance.balance).toMatchObject({ amount_minor: null, snapshot_amount_minor: "10000", estimated_amount_minor: "8750",
      as_of: snapshot.as_of, status: "stale", reconciled_rows: 1 });
  });
  it("excludes future snapshots and does not use ingestion order to resolve financial ties", () => {
    const tied = { ...snapshot, id: "tie", amount_minor: "11000", created_at: now };
    expect(resolveBalances(accounts, [snapshot, tied], [], now)[0].balance?.status).toBe("ambiguous");
    expect(resolveBalances(accounts, [tied, snapshot], [], now)[0].balance?.status).toBe("ambiguous");
    expect(resolveBalances(accounts, [{ ...snapshot, as_of: "2026-10-02T00:00:00Z" }], [], now)[0].balance?.status).toBe("missing");
  });
  it("refuses same-day ledger guesses and unsafe numeric database values", () => {
    const today = { ...snapshot, as_of: "2026-10-01T08:00:00Z" };
    expect(resolveBalances(accounts, [today], [], now)[0].balance?.amount_minor).toBe("10000");
    expect(resolveBalances(accounts, [today], [{ ...transaction, posted_on: "2026-10-01" }], now)[0].balance)
      .toMatchObject({ amount_minor: null, estimated_amount_minor: null, status: "ambiguous" });
    expect(resolveBalances(accounts, [{ ...today, amount_minor: Number.MAX_SAFE_INTEGER + 1 }], [], now)[0].balance)
      .toMatchObject({ amount_minor: null, status: "ambiguous" });
    expect(resolveBalances(accounts, [{ ...today, currency_code: "USD" }], [], now)[0].balance?.status).toBe("ambiguous");
  });
});

describe("local financial calendar", () => {
  it("represents a user-dated midnight in the reviewed zone and rejects invalid or ambiguous local times", () => {
    expect(calendarDayBoundary("2026-10-01", "America/Los_Angeles")).toBe("2026-10-01T07:00:00.000Z");
    expect(calendarDayBoundary("2026-10-01", "Europe/Berlin")).toBe("2026-09-30T22:00:00.000Z");
    expect(() => reviewedLocalTimestamp("2026-02-30T00:00:00", "Europe/Berlin")).toThrow("Invalid");
    expect(() => reviewedLocalTimestamp("2026-10-25T02:30:00", "Europe/Berlin")).toThrow("ambiguous");
    expect(() => reviewedLocalTimestamp("2026-03-29T02:30:00", "Europe/Berlin")).toThrow("nonexistent");
  });
  it("uses Berlin month/year boundaries and DST without a fixed offset", () => {
    expect(calendarDate("2026-09-30T22:30:00Z")).toBe("2026-10-01");
    expect(calendarDate("2026-12-31T23:30:00Z")).toBe("2027-01-01");
    expect(calendarDate("2026-03-29T01:30:00Z")).toBe("2026-03-29");
    expect(calendarDate("2026-10-25T01:30:00Z")).toBe("2026-10-25");
    expect(calendarDate("2024-02-29T23:30:00Z")).toBe("2024-03-01");
  });
});
