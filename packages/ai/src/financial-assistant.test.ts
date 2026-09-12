import { describe, expect, it } from "vitest";
import { financialAssistant } from "./financial-assistant.js";

describe("financial assistant capability", () => {
  it("pins its prompt, model policy, read-only tools and hard budgets", () => {
    expect(financialAssistant.key).toBe("financial-assistant");
    expect(financialAssistant.version).toBe(1);
    expect(financialAssistant.tools).toContain("analytics.spendingByCategory");
    expect(financialAssistant.budgets.maxToolCalls).toBeGreaterThan(0);
    expect(financialAssistant.providerPrivacy).toBe("no-training");
  });
});
