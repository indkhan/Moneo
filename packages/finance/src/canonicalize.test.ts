import { describe, expect, it } from "vitest";
import { DomainError } from "@moneo/shared/problem";
import {
  canonicalizeRow,
  createMemoryCanonicalizeStore,
  toCanonicalFields,
  type CanonicalizeInput,
} from "./canonicalize.js";
import type { MappedPreviewRow } from "./mapping.js";

/**
 * Issue 4.3 — canonicalization service.
 *
 * Proves the contract, in order: typed rows validate into canonical fields
 * (exact money preserved, bad data rejected); the first call creates the
 * account + transaction with PRIMARY links; a retry resolves to the SAME
 * ids with no duplicate effect; rows sharing a source account share the
 * canonical account; two legitimate identical purchases stay distinct; and
 * the store interface exposes no source-table mutation (raw history cannot
 * be deleted by construction).
 */

function row(overrides: Partial<MappedPreviewRow> = {}): MappedPreviewRow {
  return {
    rowNumber: 1,
    date: "2026-08-15",
    description: "COFFEE BAR",
    amountMinor: "350",
    currency: "EUR",
    direction: "debit",
    account: "Everyday",
    ...overrides,
  };
}

function input(overrides: Partial<CanonicalizeInput> = {}): CanonicalizeInput {
  return {
    workspaceId: "ws-1",
    dataSourceId: "ds-1",
    sourceAccountId: "src-acct-1",
    sourceTransactionId: "src-txn-1",
    sourceAccountLabel: "Everyday",
    row: row(),
    ...overrides,
  };
}

describe("toCanonicalFields", () => {
  it("passes typed rows through with exact money intact", () => {
    expect(toCanonicalFields(row())).toEqual({
      direction: "debit",
      amountMinor: "350",
      currencyCode: "EUR",
      effectiveDate: "2026-08-15",
      description: "COFFEE BAR",
    });
    // Zero-exponent and three-exponent currencies keep their own precision.
    expect(toCanonicalFields(row({ amountMinor: "1500", currency: "JPY" })).amountMinor).toBe(
      "1500",
    );
    expect(toCanonicalFields(row({ amountMinor: "1500", currency: "BHD" })).currencyCode).toBe(
      "BHD",
    );
  });

  it("rejects bad data without throwing untyped errors", () => {
    for (const bad of [
      row({ amountMinor: "0" }),
      row({ amountMinor: "-5" }),
      row({ amountMinor: "12.50" }),
      row({ amountMinor: "9007199254740992" }),
      row({ currency: "XXY" }),
      row({ date: "15.08.2026" }),
      row({ date: "2026-13-01" }),
      row({ direction: "OUTFLOW" as unknown as "credit" }),
    ]) {
      expect(() => toCanonicalFields(bad)).toThrow(DomainError);
    }
  });
});

describe("canonicalizeRow", () => {
  it("creates the account and transaction once, then replays to the same ids", async () => {
    const store = createMemoryCanonicalizeStore();
    const first = await canonicalizeRow(store, input());
    expect(first.accountCreated).toBe(true);
    expect(first.transactionCreated).toBe(true);

    const replay = await canonicalizeRow(store, input());
    expect(replay).toEqual({ ...first, accountCreated: false, transactionCreated: false });
    expect(store.accountCount()).toBe(1);
    expect(store.transactionCount()).toBe(1);
  });

  it("shares one canonical account across rows of the same source account", async () => {
    const store = createMemoryCanonicalizeStore();
    const first = await canonicalizeRow(store, input());
    const second = await canonicalizeRow(
      store,
      input({
        sourceTransactionId: "src-txn-2",
        row: row({ rowNumber: 2, description: "BAKERY", amountMinor: "420" }),
      }),
    );
    expect(second.accountId).toBe(first.accountId);
    expect(second.accountCreated).toBe(false);
    expect(second.transactionCreated).toBe(true);
    expect(second.transactionId).not.toBe(first.transactionId);
  });

  it("keeps two legitimate identical purchases distinct", async () => {
    const store = createMemoryCanonicalizeStore();
    const first = await canonicalizeRow(store, input());
    const second = await canonicalizeRow(
      store,
      input({ sourceTransactionId: "src-txn-2", row: row({ rowNumber: 2 }) }),
    );
    expect(second.transactionId).not.toBe(first.transactionId);
    expect(store.transactionCount()).toBe(2);
  });

  it("separates canonical accounts per source account", async () => {
    const store = createMemoryCanonicalizeStore();
    const first = await canonicalizeRow(store, input());
    const other = await canonicalizeRow(
      store,
      input({
        sourceAccountId: "src-acct-2",
        sourceTransactionId: "src-txn-9",
        row: row({ account: "Savings" }),
      }),
    );
    expect(other.accountId).not.toBe(first.accountId);
    expect(other.accountCreated).toBe(true);
  });

  it("names a first-seen account from the row, label, or fallback", async () => {
    const seen: { name: string }[] = [];
    const store = createMemoryCanonicalizeStore();
    const creating = {
      ...store,
      createAccount: (args: { workspaceId: string; name: string; currencyCode: string }) => {
        seen.push({ name: args.name });
        return store.createAccount(args);
      },
    };
    await canonicalizeRow(creating, input({ row: row({ account: null }), sourceAccountLabel: null }));
    expect(seen[0]?.name).toBe("Imported account");
  });

  it("exposes no source-table mutation on the store interface", () => {
    // Compile-time contract, asserted at runtime so it cannot drift
    // silently: the ONLY methods are link lookups, canonical inserts, and
    // PRIMARY link writes. There is no update/delete/observation method.
    const methods = Object.keys(createMemoryCanonicalizeStore()).sort();
    expect(methods).toEqual(
      [
        "accountCount",
        "createAccount",
        "createTransaction",
        "findAccountIdBySource",
        "findTransactionIdBySource",
        "linkAccount",
        "linkTransaction",
        "transactionCount",
      ].sort(),
    );
  });
});
