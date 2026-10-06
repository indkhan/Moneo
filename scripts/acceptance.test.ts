import { describe, expect, it } from "vitest";
import { assertRequiredResults } from "./acceptance-results.mjs";

describe("required acceptance reports", () => {
  it("rejects a successful unit command whose live DB test was skipped", () => {
    expect(() => assertRequiredResults("vitest", { success: true, numTotalTests: 1, numPendingTests: 1, numFailedTests: 0 })).toThrow(/skipped/);
  });
  it("rejects skipped, failed, flaky or empty browser acceptance", () => {
    for (const stats of [{ expected: 1, skipped: 1 }, { expected: 1, unexpected: 1 }, { expected: 1, flaky: 1 }, { expected: 0 }]) {
      expect(() => assertRequiredResults("playwright", { stats })).toThrow();
    }
  });
  it("accepts fully executed successful reports", () => {
    expect(() => assertRequiredResults("vitest", { success: true, numTotalTests: 1, numPendingTests: 0, numFailedTests: 0 })).not.toThrow();
    expect(() => assertRequiredResults("playwright", { stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 } })).not.toThrow();
  });
});
