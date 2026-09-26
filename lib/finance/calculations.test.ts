import { describe, expect, it } from "vitest";
import { availableToSpendCents, formatCents, sumCents } from "./calculations";

describe("finance calculations (exact, in cents)", () => {
  it("sums without float drift", () => {
    expect(sumCents([1999, 1])).toBe(2000);
  });

  it("computes available-to-spend", () => {
    expect(
      availableToSpendCents({ balances: [100000], reserved: [20000], upcoming: [5000] }),
    ).toBe(75000);
  });

  it("formats cents", () => {
    expect(formatCents(75000)).toBe("$750.00");
  });
});
