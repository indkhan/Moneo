import { describe, expect, it } from "vitest";
import { buildSavedFilters, invalidStoredViewScope, parseStoredFilters, parseViewId, parseViewName } from "./validate";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const UUID2 = "123e4567-e89b-12d3-a456-426614174001";

describe("saved view identity", () => {
  it("accepts opaque UUIDs and view names", () => {
    expect(parseViewId(UUID)).toBe(UUID);
    expect(parseViewId("not-a-uuid")).toBeNull();
    expect(parseViewId(undefined)).toBeNull();
    expect(parseViewName("  Coffee  ")).toBe("Coffee");
    expect(parseViewName("")).toBeNull();
    expect(parseViewName("x".repeat(81))).toBeNull();
    expect(parseViewName("x".repeat(80))).toBe("x".repeat(80));
  });
});

describe("buildSavedFilters strict save path", () => {
  it("builds a full filter set and canonicalizes amounts", () => {
    expect(
      buildSavedFilters({
        q: " coffee ",
        from: "2026-08-01",
        to: "2026-09-01",
        account: UUID,
        status: "posted",
        kind: "ordinary",
        direction: "outflow",
        category: UUID2,
        merchant: "none",
        minAmount: "007",
        maxAmount: "-1099",
        sort: "amount-desc",
      }),
    ).toEqual({
      q: "coffee",
      from: "2026-08-01",
      to: "2026-09-01",
      accountId: UUID,
      status: "posted",
      kind: "ordinary",
      direction: "outflow",
      categoryId: UUID2,
      merchantUnknown: true,
      minAmountMinor: "7",
      maxAmountMinor: "-1099",
      sort: "amount-desc",
    });
  });

  it("omits empties and default sort", () => {
    expect(buildSavedFilters({})).toEqual({});
    expect(buildSavedFilters({ sort: "date-desc", q: "   " })).toEqual({});
    expect(buildSavedFilters({ category: "none" })).toEqual({ uncategorized: true });
    expect(buildSavedFilters({ merchant: UUID })).toEqual({ merchantId: UUID });
  });

  it("throws instead of silently dropping invalid input", () => {
    expect(() => buildSavedFilters({ account: "nope" })).toThrow();
    expect(() => buildSavedFilters({ from: "2026-13-01" })).toThrow();
    expect(() => buildSavedFilters({ status: "everything" })).toThrow();
    expect(() => buildSavedFilters({ kind: "evil" })).toThrow();
    expect(() => buildSavedFilters({ direction: "sideways" })).toThrow();
    expect(() => buildSavedFilters({ category: "nope" })).toThrow();
    expect(() => buildSavedFilters({ merchant: "nope" })).toThrow();
    expect(() => buildSavedFilters({ minAmount: "10.99" })).toThrow();
    expect(() => buildSavedFilters({ maxAmount: "9223372036854775808" })).toThrow();
    expect(() => buildSavedFilters({ sort: "description" })).toThrow();
  });
});

describe("saved tag/event scope (MNE-041)", () => {
  it("keeps tag and event through the save path alongside other filters", () => {
    expect(
      buildSavedFilters({ tag: " Holiday ", event: " Berlin trip ", status: "posted" }),
    ).toEqual({ tag: "holiday", eventName: "Berlin trip", status: "posted" });
  });

  it("round-trips a full view through stored JSON to the same semantic query", () => {
    const saved = buildSavedFilters({
      q: "coffee",
      from: "2026-08-01",
      to: "2026-09-01",
      account: UUID,
      status: "posted",
      category: UUID2,
      tag: "Holiday",
      event: "Berlin trip",
      sort: "amount-desc",
    });
    const reloaded = parseStoredFilters(JSON.parse(JSON.stringify(saved)));
    expect(reloaded).toEqual(saved);
    expect(reloaded.tag).toBe("holiday");
    expect(reloaded.eventName).toBe("Berlin trip");
  });

  it("throws on oversized tag/event instead of silently broadening the view", () => {
    expect(() => buildSavedFilters({ tag: "x".repeat(41) })).toThrow();
    expect(() => buildSavedFilters({ event: "x".repeat(121) })).toThrow();
    expect(buildSavedFilters({ tag: "   ", event: "" })).toEqual({});
  });

  it("flags a present-but-invalid persisted scope instead of broadening it", () => {
    expect(invalidStoredViewScope({ status: "posted" })).toBeNull();
    expect(invalidStoredViewScope({})).toBeNull();
    expect(invalidStoredViewScope({ tag: "holiday", eventName: "Berlin trip" })).toBeNull();
    expect(invalidStoredViewScope({ tag: "x".repeat(41) })).toMatch(/invalid tag/);
    expect(invalidStoredViewScope({ eventName: "x".repeat(121) })).toMatch(/invalid spending-group/);
    expect(invalidStoredViewScope({ tag: 7 })).toMatch(/invalid tag/);
    expect(invalidStoredViewScope(null)).toMatch(/invalid/);
    expect(invalidStoredViewScope("evil")).toMatch(/invalid/);
  });

  it("loads legacy views and never restores cursor or open-transaction ids", () => {
    expect(parseStoredFilters({ status: "posted" })).toEqual({ status: "posted" });
    expect(
      parseStoredFilters({
        tag: "  HOLIDAY  ",
        eventName: "  Berlin trip  ",
        cursor: "2026-09-01|evil",
        transaction: UUID,
        transactionId: UUID,
      }),
    ).toEqual({ tag: "holiday", eventName: "Berlin trip" });
    expect(parseStoredFilters({ tag: "x".repeat(41), eventName: "x".repeat(121) })).toEqual({});
  });
});

describe("parseStoredFilters tolerant load path", () => {
  it("drops unknown keys and invalid values without throwing", () => {
    expect(parseStoredFilters(null)).toEqual({});
    expect(parseStoredFilters("evil")).toEqual({});
    expect(
      parseStoredFilters({
        q: "  coffee  ",
        from: "not-a-date",
        accountId: "nope",
        status: "posted",
        evil: "injection",
        minAmountMinor: "10.99",
        maxAmountMinor: "100",
        sort: "date-desc",
        cursor: "2026-09-01|evil",
        transaction: UUID,
      }),
    ).toEqual({ q: "coffee", status: "posted", maxAmountMinor: "100" });
  });

  it("prefers uncategorized/unknown flags and keeps default sort implicit", () => {
    expect(parseStoredFilters({ categoryId: UUID, uncategorized: true })).toEqual({ uncategorized: true });
    expect(parseStoredFilters({ merchantId: UUID, merchantUnknown: true })).toEqual({ merchantUnknown: true });
    expect(parseStoredFilters({ sort: "amount-asc" })).toEqual({ sort: "amount-asc" });
  });
});
