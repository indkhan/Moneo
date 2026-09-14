import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvidenceView } from "./EvidenceView";

describe("EvidenceView", () => {
  it("makes filters, cutoff, and contributing transaction links inspectable", () => {
    const html = renderToStaticMarkup(
      h(EvidenceView, {
        evidence: {
          toolName: "analytics.spending",
          input: { category: "Restaurants" },
          output: {
            result: "293.00 EUR",
            evidence: {
              dataCutoff: "2026-09-01",
              calculationMetadata: { filters: { category: "Restaurants" } },
              rows: [{ id: "t1", accountId: "a1" }],
            },
          },
        },
      }),
    );
    expect(html).toContain("Restaurants");
    expect(html).toContain("2026-09-01");
    expect(html).toContain("293.00 EUR");
    expect(html).toContain("/money/transactions?transactionId=t1");
  });
});
