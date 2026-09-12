import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Account, Transaction } from "../generated/client";
import { AccountsList, formatBalance } from "./AccountsView";
import { TransactionsTable, formatTransactionAmount } from "./TransactionsView";

/**
 * Issue 4.7 — Money views render to static markup (no browser needed).
 *
 * Proves the presentation contract: account names with exact formatted
 * balances, unknown balances as "Unknown" (never zero), transaction rows
 * with exact amounts, spacer rows for the virtual window, and the empty
 * state. Data fetching itself is covered by the handler/query tests.
 */

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "22222222-2222-7222-8222-222222222222",
    name: "Everyday checking",
    institutionName: null,
    accountType: "CHECKING",
    currencyCode: "EUR",
    isSpendable: true,
    includeInNetWorth: true,
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    balance: {
      currentAmountMinor: "12500",
      availableAmountMinor: null,
      currencyCode: "EUR",
      observedAt: "2026-08-15T00:00:00.000Z",
      source: "statement",
    },
    ...overrides,
  };
}

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "44444444-4444-7444-8444-444444444444",
    accountId: "22222222-2222-7222-8222-222222222222",
    status: "POSTED",
    direction: "debit",
    amountMinor: "1550",
    currencyCode: "EUR",
    effectiveDate: "2026-08-15",
    description: "COFFEE BAR",
    note: null,
    excludedFromAnalytics: false,
    createdAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:00.000Z",
    ...overrides,
  };
}

describe("AccountsList", () => {
  it("renders names with exact balances and Unknown for missing snapshots", () => {
    const html = renderToStaticMarkup(
      h(AccountsList, {
        accounts: [account(), account({ id: "x", name: "Cash", balance: null })],
      }),
    );
    expect(html).toContain("Everyday checking");
    expect(html).toContain("125.00 EUR");
    expect(html).toContain("Cash");
    expect(html).toContain("Unknown");
    expect(html).not.toContain("0.00 EUR");
  });

  it("renders the empty state with no accounts", () => {
    const html = renderToStaticMarkup(h(AccountsList, { accounts: [] }));
    expect(html).toContain("No accounts yet");
  });
});

describe("formatBalance", () => {
  it("keeps zero-exponent currencies exact", () => {
    expect(
      formatBalance(
        account({
          currencyCode: "JPY",
          balance: {
            currentAmountMinor: "1500",
            availableAmountMinor: null,
            currencyCode: "JPY",
            observedAt: "2026-08-15T00:00:00.000Z",
            source: "manual",
          },
        }),
      ),
    ).toBe("1,500 JPY");
  });
});

describe("TransactionsTable", () => {
  it("renders headers and rows with exact amounts", () => {
    const rows = [
      { ...transaction(), accountName: "Everyday checking" },
      {
        ...transaction({
          id: "b",
          description: "SALARY",
          direction: "credit",
          amountMinor: "200000",
        }),
        accountName: "Everyday checking",
      },
    ];
    const html = renderToStaticMarkup(h(TransactionsTable, { rows }));
    for (const header of ["Date", "Description", "Account", "Direction", "Amount"]) {
      expect(html).toContain(header);
    }
    expect(html).toContain("COFFEE BAR");
    expect(html).toContain("-15.50 EUR");
    expect(html).toContain("2,000.00 EUR");
    expect(html).toContain("Everyday checking");
  });

  it("renders virtual-window spacer rows without dropping content", () => {
    const rows = [{ ...transaction(), accountName: "Everyday checking" }];
    const html = renderToStaticMarkup(h(TransactionsTable, { rows, padTop: 440, padBottom: 880 }));
    expect(html).toContain("COFFEE BAR");
    expect(html).toContain("height:440px");
    expect(html).toContain("height:880px");
  });

  it("adds a View control per row only when selection is wired", () => {
    const rows = [{ ...transaction(), accountName: "Everyday checking" }];
    const plain = renderToStaticMarkup(h(TransactionsTable, { rows }));
    expect(plain).not.toContain("View");
    const selectable = renderToStaticMarkup(
      h(TransactionsTable, {
        rows,
        onSelect: () => undefined,
      }),
    );
    expect(selectable).toContain("Details");
    expect(selectable).toContain('aria-label="View COFFEE BAR"');
  });
});

describe("formatTransactionAmount", () => {
  it("signs debits and keeps credits plain", () => {
    expect(formatTransactionAmount(transaction())).toBe("-15.50 EUR");
    expect(formatTransactionAmount(transaction({ direction: "credit" }))).toBe("15.50 EUR");
  });
});
