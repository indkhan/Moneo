import { describe, expect, it } from "vitest";
import { DomainError } from "@moneo/shared/problem";
import {
  CALCULATION_VERSION,
  FX_SEED_ANCHORS,
  FX_SEED_MAX_AGE_DAYS,
  convertMinorUnits,
  invertRate,
  parseDecimalRate,
  roundHalfEvenQuotient,
  seedAnchorsFor,
  selectManualRate,
  selectPublishedRate,
} from "./fx.js";

/**
 * Issue 4.9 — FX math and policy unit tests.
 *
 * Every numeric vector below is hand-computed (see comments): the tests pin
 * exact decimal conversion, half-even ties, 15dp inversion, max-age
 * boundaries, and the no-future rule without touching a database.
 */
describe("parseDecimalRate", () => {
  it("splits exact decimals into coefficient and scale", () => {
    expect(parseDecimalRate("170.12345")).toEqual({ coeff: 17012345n, scale: 5 });
    expect(parseDecimalRate("2")).toEqual({ coeff: 2n, scale: 0 });
  });

  it("rejects non-positive and malformed rates", () => {
    for (const bad of ["", "abc", "1.2.3", "-1", "0", "0.00", " 1", "1 "]) {
      expect(() => parseDecimalRate(bad)).toThrow(DomainError);
    }
  });
});

describe("roundHalfEvenQuotient", () => {
  it("rounds ties to the even neighbor", () => {
    expect(roundHalfEvenQuotient(5n, 10n)).toBe(0n); // 0.5 → 0
    expect(roundHalfEvenQuotient(15n, 10n)).toBe(2n); // 1.5 → 2
    expect(roundHalfEvenQuotient(25n, 10n)).toBe(2n); // 2.5 → 2
    expect(roundHalfEvenQuotient(35n, 10n)).toBe(4n); // 3.5 → 4
    expect(roundHalfEvenQuotient(7n, 2n)).toBe(4n);
    expect(roundHalfEvenQuotient(5n, 2n)).toBe(2n);
  });

  it("rounds non-ties normally", () => {
    expect(roundHalfEvenQuotient(882352941176400000n, 1_000_000_000_000_000n)).toBe(882n);
    expect(roundHalfEvenQuotient(8827n, 1000n)).toBe(9n);
  });
});

describe("invertRate", () => {
  it("inverts exactly at 15dp, half-even", () => {
    expect(invertRate("2")).toBe("0.500000000000000");
    // 1/170 = 0.0058823529411764705… → 15dp, next digit 4 rounds down.
    expect(invertRate("170.00000")).toBe("0.005882352941176");
  });
});

describe("convertMinorUnits", () => {
  it("converts JPY 1500 at the August seed inverse to EUR 8.82", () => {
    // 1500 × 0.005882352941176 = 8.823529… → €8.82 (×100 minor = 882).
    expect(convertMinorUnits("1500", "JPY", "0.005882352941176", "EUR")).toBe("882");
  });

  it("keeps identity conversions exact and rejects bad inputs", () => {
    expect(convertMinorUnits("100", "EUR", "1", "EUR")).toBe("100");
    expect(() => convertMinorUnits("12.50", "EUR", "1", "EUR")).toThrow(DomainError);
    expect(() => convertMinorUnits("100", "XXY", "1", "EUR")).toThrow(DomainError);
    expect(() => convertMinorUnits("9007199254740991", "JPY", "2", "JPY")).toThrow(DomainError);
  });
});

describe("selectPublishedRate", () => {
  const anchors = [
    { rateDate: "2026-07-01", rate: "171.00000" },
    { rateDate: "2026-08-01", rate: "172.00000" },
    { rateDate: "2026-10-01", rate: "174.00000" },
  ];

  it("picks the latest prior anchor within the age limit", () => {
    expect(selectPublishedRate("2026-08-15", anchors)).toEqual({
      rateDate: "2026-08-01",
      rate: "172.00000",
      source: "seed",
    });
    expect(selectPublishedRate("2026-07-01", anchors)?.rateDate).toBe("2026-07-01");
  });

  it("refuses stale coverage, missing history, and future anchors", () => {
    // Aug 01 anchor is 35 days before Sep 05: older than the 31-day limit.
    expect(selectPublishedRate("2026-09-05", anchors)).toBeNull();
    expect(selectPublishedRate("2026-06-30", anchors)).toBeNull();
    // The Oct anchor exists but must never price an August transaction.
    expect(selectPublishedRate("2026-08-15", anchors)?.rateDate).toBe("2026-08-01");
    expect(FX_SEED_MAX_AGE_DAYS).toBe(31);
  });
});

describe("selectManualRate", () => {
  const rows = [
    { rateDate: "2026-03-15", rate: "0.5" },
    { rateDate: "2026-08-15", rate: "0.6" },
    { rateDate: "2026-12-01", rate: "0.7" },
  ];

  it("uses the latest user rate on or before the date, ignoring age", () => {
    expect(selectManualRate("2026-11-01", rows)).toEqual({
      rateDate: "2026-08-15",
      rate: "0.6",
      source: "manual",
    });
    expect(selectManualRate("2026-12-01", rows)?.rate).toBe("0.7");
  });

  it("never applies future-dated manual rows retroactively", () => {
    expect(selectManualRate("2026-08-14", rows)?.rateDate).toBe("2026-03-15");
    expect(selectManualRate("2026-01-01", rows)).toBeNull();
  });
});

describe("seedAnchorsFor", () => {
  it("serves direct EUR legs and inverted return legs, but no JPY→BHD path", () => {
    expect(seedAnchorsFor("EUR", "JPY")).toHaveLength(12);
    const inverted = seedAnchorsFor("JPY", "EUR");
    expect(inverted).toHaveLength(12);
    expect(inverted[0]).toEqual({ rateDate: "2026-01-01", rate: invertRate("170.00000") });
    expect(seedAnchorsFor("JPY", "BHD")).toEqual([]);
    expect(FX_SEED_ANCHORS.length).toBe(36);
    expect(CALCULATION_VERSION).toBe("v1");
  });
});
