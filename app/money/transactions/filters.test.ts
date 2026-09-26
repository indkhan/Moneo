import { describe, expect, it } from "vitest";
import {
  cursorClause,
  nextCursorForRow,
  parseMinorUnits,
  parseTransactionParams,
  toQueryParams,
  toggleSort,
} from "./filters";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const UUID2 = "123e4567-e89b-12d3-a456-426614174001";

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

  it("builds keyset clauses only from the fixed column map", () => {
    const cursor = { value: "2026-09-01", id: UUID };
    expect(cursorClause("date-desc", cursor)).toBe(
      `posted_on.lt.2026-09-01,and(posted_on.eq.2026-09-01,id.lt.${UUID})`,
    );
    expect(cursorClause("date-asc", cursor)).toBe(
      `posted_on.gt.2026-09-01,and(posted_on.eq.2026-09-01,id.gt.${UUID})`,
    );
    expect(cursorClause("amount-desc", { value: "-1099", id: UUID })).toBe(
      `amount_minor.lt.-1099,and(amount_minor.eq.-1099,id.lt.${UUID})`,
    );
    expect(cursorClause("amount-asc", { value: "-1099", id: UUID })).toBe(
      `amount_minor.gt.-1099,and(amount_minor.eq.-1099,id.gt.${UUID})`,
    );
  });

  it("toggles date and amount headers", () => {
    expect(toggleSort("date-desc", "date")).toBe("date-asc");
    expect(toggleSort("amount-desc", "date")).toBe("date-desc");
    expect(toggleSort("amount-desc", "amount")).toBe("amount-asc");
    expect(toggleSort("date-desc", "amount")).toBe("amount-desc");
  });
});

describe("transaction cursor validation", () => {
  it("accepts a date cursor for date sorts and rejects injection", () => {
    expect(parseTransactionParams({ cursor: `2026-09-01|${UUID}` }).cursor).toEqual({
      value: "2026-09-01",
      id: UUID,
    });
    expect(parseTransactionParams({ cursor: `2026-09-01),x|${UUID}` }).cursor).toBeUndefined();
    expect(parseTransactionParams({ cursor: `-1099|${UUID}` }).cursor).toBeUndefined();
    expect(parseTransactionParams({ cursor: `2026-09-01|not-a-uuid` }).cursor).toBeUndefined();
  });

  it("accepts a minor-unit cursor for amount sorts", () => {
    const parsed = parseTransactionParams({ sort: "amount-desc", cursor: `-1099|${UUID}` });
    expect(parsed.cursor).toEqual({ value: "-1099", id: UUID });
    expect(parseTransactionParams({ sort: "amount-desc", cursor: `10.99|${UUID}` }).cursor).toBeUndefined();
    expect(parseTransactionParams({ sort: "amount-desc", cursor: `2026-09-01|${UUID}` }).cursor).toBeUndefined();
  });

  it("encodes the next cursor from the row's sort value", () => {
    const row = { posted_on: "2026-09-01", amount_minor: "-1099", id: UUID };
    expect(nextCursorForRow(row, "date-desc")).toBe(`2026-09-01|${UUID}`);
    expect(nextCursorForRow(row, "amount-desc")).toBe(`-1099|${UUID}`);
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

  it("round-trips shareable params and drops the cursor by default", () => {
    const parsed = parseTransactionParams({
      q: "coffee",
      category: "none",
      minAmount: "100",
      sort: "amount-desc",
      cursor: `-5|${UUID2}`,
      transaction: UUID,
    });
    const withoutCursor = toQueryParams(parsed);
    expect(withoutCursor.get("cursor")).toBeNull();
    expect(withoutCursor.get("category")).toBe("none");
    expect(withoutCursor.get("minAmount")).toBe("100");
    expect(withoutCursor.get("sort")).toBe("amount-desc");
    expect(withoutCursor.get("transaction")).toBeNull();
    expect(toQueryParams(parsed, { includeCursor: true }).get("cursor")).toBe(`-5|${UUID2}`);
    expect(toQueryParams(parseTransactionParams({})).get("sort")).toBeNull();
  });
});
