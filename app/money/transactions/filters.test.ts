import { describe, expect, it } from "vitest";
import {
  parseMinorUnits,
  parseTransactionParams,
  toQueryParams,
  toggleSort,
} from "./filters";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("transaction minor-unit amounts", () => {
  it("accepts exact integer strings without floating point", () => {
    expect(parseMinorUnits("-1099")).toBe("-1099");
    expect(parseMinorUnits("0")).toBe("0");
    expect(parseMinorUnits("007")).toBe("7");
    expect(parseMinorUnits("9223372036854775807")).toBe("9223372036854775807");
  });

  it("rejects floats, garbage and bigint overflow", () => {
    expect(parseMinorUnits("10.99")).toBeUndefined();
    expect(parseMinorUnits("1e3")).toBeUndefined();
    expect(parseMinorUnits("abc")).toBeUndefined();
    expect(parseMinorUnits("")).toBeUndefined();
    expect(parseMinorUnits(undefined)).toBeUndefined();
    expect(parseMinorUnits("9223372036854775808")).toBeUndefined();
    expect(parseMinorUnits("-9223372036854775809")).toBeUndefined();
  });
});

describe("transaction sort safety", () => {
  it("defaults to date-desc and rejects unsafe sort columns", () => {
    expect(parseTransactionParams({}).sort).toBe("date-desc");
    for (const evil of ["description", "posted_on", "amount_minor", "id;drop", "DATE-DESC", "amount-desc ", "q"]) {
      expect(parseTransactionParams({ sort: evil }).sort).toBe("date-desc");
    }
    expect(parseTransactionParams({ sort: "amount-asc" }).sort).toBe("amount-asc");
  });

  it("toggles date and amount headers", () => {
    expect(toggleSort("date-desc", "date")).toBe("date-asc");
    expect(toggleSort("amount-desc", "date")).toBe("date-desc");
    expect(toggleSort("amount-desc", "amount")).toBe("amount-asc");
    expect(toggleSort("date-desc", "amount")).toBe("amount-desc");
  });
});

describe("transaction page number", () => {
  it("accepts whole pages above 1 and ignores anything else", () => {
    expect(parseTransactionParams({ page: "3" }).page).toBe(3);
    for (const page of ["1", "0", "-2", "2.5", "x", "9999999"]) expect(parseTransactionParams({ page }).page).toBeUndefined();
  });
});

describe("transaction filter params", () => {
  it("parses category uuid, uncategorized and amount range", () => {
    const parsed = parseTransactionParams({
      category: UUID,
      minAmount: "-100",
      maxAmount: "2500",
    });
    expect(parsed.categoryId).toBe(UUID);
    expect(parsed.minAmountMinor).toBe("-100");
    expect(parsed.maxAmountMinor).toBe("2500");
    expect(parseTransactionParams({ category: "none" }).uncategorized).toBe(true);
    expect(parseTransactionParams({ category: "nope" }).categoryId).toBeUndefined();
    expect(parseTransactionParams({ minAmount: "10.99" }).minAmountMinor).toBeUndefined();
  });

  it("round-trips shareable params and drops the page by default", () => {
    const parsed = parseTransactionParams({
      q: "coffee",
      category: "none",
      minAmount: "100",
      sort: "amount-desc",
      page: "4",
      transaction: UUID,
    });
    const withoutCursor = toQueryParams(parsed);
    expect(withoutCursor.get("page")).toBeNull();
    expect(withoutCursor.get("category")).toBe("none");
    expect(withoutCursor.get("minAmount")).toBe("100");
    expect(withoutCursor.get("sort")).toBe("amount-desc");
    expect(withoutCursor.get("transaction")).toBeNull();
    expect(toQueryParams(parsed, { includePage: true }).get("page")).toBe("4");
    expect(toQueryParams(parseTransactionParams({})).get("sort")).toBeNull();
  });

  it("parses merchant, tag, spending group and display grouping from the URL", () => {
    const parsed = parseTransactionParams({ merchant: UUID, tag: " Trip ", event: " Berlin ", group: "month" });
    expect(parsed).toMatchObject({ merchantId: UUID, tag: "trip", eventName: "Berlin", group: "month" });
    expect(parseTransactionParams({ merchant: "none", group: "evil", tag: "x".repeat(41) })).toEqual({ merchantUnknown: true, sort: "date-desc" });
    expect(toQueryParams(parsed).toString()).toBe(`merchant=${UUID}&tag=trip&event=Berlin&group=month`);
  });
});
