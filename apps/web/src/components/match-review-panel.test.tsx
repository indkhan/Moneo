import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MatchCandidate } from "../generated/client";
import { MatchReviewList } from "./MatchReviewPanel";

/**
 * Issue 4.11 — review list renders to static markup (no browser needed).
 *
 * Proves the presentation contract: both sides' descriptions, one Link and
 * one Keep control per row, the empty state, and disabled controls while a
 * decision is in flight. Fetching itself is covered by handler tests.
 */

function candidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    id: "33333333-3333-7333-8333-333333333333",
    importId: "22222222-2222-7222-8222-222222222222",
    sourceTransactionId: "44444444-4444-7444-8444-444444444444",
    candidateTransactionId: "55555555-5555-7555-8555-555555555555",
    matchRule: "fuzzy-date-amount-description",
    candidateDate: "2026-08-12",
    candidateDescription: "BOOKSTORE",
    candidateAmountMinor: "2499",
    candidateCurrency: "EUR",
    stagedDescription: "Bookstore",
    stagedDate: "2026-08-12",
    stagedAmountMinor: "2499",
    stagedCurrency: "EUR",
    stagedDirection: "debit",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("MatchReviewList", () => {
  it("shows both sides with link and keep controls per row", () => {
    const html = renderToStaticMarkup(
      h(MatchReviewList, { items: [candidate()], resolvingId: null, onResolve: () => undefined }),
    );
    expect(html).toContain("Bookstore");
    expect(html).toContain("BOOKSTORE");
    expect(html).toContain("Link to existing");
    expect(html).toContain("Keep distinct");
  });

  it("disables controls while a decision is in flight", () => {
    const html = renderToStaticMarkup(
      h(MatchReviewList, {
        items: [candidate()],
        resolvingId: "33333333-3333-7333-8333-333333333333",
        onResolve: () => undefined,
      }),
    );
    expect(html).toContain("disabled");
  });

  it("explains the empty state when nothing needs review", () => {
    const html = renderToStaticMarkup(
      h(MatchReviewList, { items: [], resolvingId: null, onResolve: () => undefined }),
    );
    expect(html).toContain("No rows need review");
  });
});
