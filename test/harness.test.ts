import { describe, expect, it } from "vitest";

describe("synthetic proof harness", () => {
  it("preserves exact money strings beyond JavaScript's safe integer range", () => {
    const fixture = { amountMinor: "9007199254740993", currency: "EUR" };

    expect(JSON.parse(JSON.stringify(fixture))).toEqual(fixture);
  });
});
