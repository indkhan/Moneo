import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Account } from "../generated/client";
import { ManualTransactionForm } from "./ManualTransactionForm";
import { NewAccountForm } from "./NewAccountForm";

/**
 * Issue 4.12 — entry forms render to static markup (no browser needed).
 *
 * Proves the presentation contract: labeled name/currency/type controls
 * for accounts; account/date/description/amount/direction controls for
 * cash transactions. Submission itself goes through the tested command
 * handlers.
 */

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "22222222-2222-7222-8222-222222222222",
    name: "Cash wallet",
    institutionName: null,
    accountType: "CASH",
    currencyCode: "EUR",
    isSpendable: true,
    includeInNetWorth: true,
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    balanceState: "unknown",
    balance: null,
    ...overrides,
  };
}

describe("NewAccountForm", () => {
  it("renders name, currency, and type controls", () => {
    const html = renderToStaticMarkup(
      h(NewAccountForm, { onCreated: () => undefined, onCancel: () => undefined }),
    );
    expect(html).toContain("New manual account");
    expect(html).toContain("Cash wallet");
    expect(html).toContain("EUR");
    expect(html).toContain("CASH");
    expect(html).toContain("Create account");
  });
});

describe("ManualTransactionForm", () => {
  it("renders account, date, description, amount, and direction controls", () => {
    const html = renderToStaticMarkup(
      h(ManualTransactionForm, {
        accounts: [account()],
        onRecorded: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(html).toContain("Record cash transaction");
    expect(html).toContain("Cash wallet");
    expect(html).toContain("Cash coffee");
    expect(html).toContain("Spent (debit)");
    expect(html).toContain("Received (credit)");
    expect(html).toContain("Record transaction");
  });
});
