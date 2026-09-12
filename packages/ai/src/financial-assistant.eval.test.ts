import { describe, expect, it } from "vitest";
import { evaluateFinancialAnswer } from "./financial-assistant.eval.js";

describe("financial assistant eval harness", () => {
  it("scores numeric and evidence correctness without treating merchant text as instructions", () => {
    const score = evaluateFinancialAnswer({ answer: "You spent 25.00 EUR.", expectedAmountMinor: "2500", evidenceRef: "ev_safe", expectedEvidenceRef: "ev_safe", tool: "analytics.spendingByCategory", expectedTool: "analytics.spendingByCategory" });
    expect(score).toEqual({ numericCorrect: true, toolSelected: true, evidenceCorrect: true, unsupportedClaim: false });
  });
});
