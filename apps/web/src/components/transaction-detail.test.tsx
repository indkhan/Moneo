import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TransactionDetail } from "../generated/client";
import { TransactionDetailContent } from "./TransactionDetailDrawer";

/**
 * Issue 4.8 — drawer content renders to static markup (no browser needed).
 *
 * Proves the presentation contract: canonical fields with the exact
 * amount, source/import provenance per linked observation, the verbatim
 * raw payload behind "View original", and the manual-row message when
 * there is no imported source.
 */

function detail(overrides: Partial<TransactionDetail> = {}): TransactionDetail {
  return {
    id: "22222222-2222-7222-8222-222222222222",
    accountId: "33333333-3333-7333-8333-333333333333",
    status: "POSTED",
    direction: "debit",
    amountMinor: "1550",
    currencyCode: "EUR",
    effectiveDate: "2026-08-15",
    description: "COFFEE BAR",
    note: null,
    excludedFromAnalytics: false,
    version: "3",
    createdAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:00.000Z",
    accountName: "Everyday checking",
    categoryId: null,
    categoryName: null,
    counterpartyId: null,
    counterpartyName: null,
    tags: [],
    sources: [
      {
        sourceTransactionId: "55555555-5555-7555-8555-555555555555",
        relationship: "PRIMARY",
        dataSourceId: "66666666-6666-7666-8666-666666666666",
        dataSourceName: "Revolut CSV",
        importId: "77777777-7777-7777-8777-777777777777",
        fileName: "august.csv",
        observedAt: "2026-08-15T10:00:00.000Z",
        rawPayload: { date: "15.08.2026", amount: "15,50" },
      },
    ],
    ...overrides,
  };
}

describe("TransactionDetailContent", () => {
  it("shows canonical fields with the exact amount", () => {
    const html = renderToStaticMarkup(h(TransactionDetailContent, { detail: detail() }));
    expect(html).toContain("COFFEE BAR");
    expect(html).toContain("2026-08-15");
    expect(html).toContain("Everyday checking");
    expect(html).toContain("-15.50 EUR");
  });

  it("shows provenance with the verbatim original behind View original", () => {
    const html = renderToStaticMarkup(h(TransactionDetailContent, { detail: detail() }));
    expect(html).toContain("Revolut CSV");
    expect(html).toContain("august.csv");
    expect(html).toContain("View original");
    expect(html).toContain("15.08.2026");
    expect(html).toContain("15,50");
  });

  it("explains manual rows with no imported source", () => {
    const html = renderToStaticMarkup(
      h(TransactionDetailContent, { detail: detail({ sources: [] }) }),
    );
    expect(html).toContain("Manually recorded");
    expect(html).not.toContain("View original");
  });
});
