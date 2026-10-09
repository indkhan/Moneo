import { describe, expect, it } from "vitest";
import { mapRows, normalizeCategoryName, parseCsv, resolveMerchantName } from "./csv";
import { importRowPayload } from "./import-row";

const base = {
  accountName: "Checking",
  currencyCode: "EUR",
  dateColumn: "Date",
  descriptionColumn: "Description",
  amountColumn: "Amount",
  dateFormat: "iso" as const,
  amountSign: "signed" as const,
};

describe("import-time merchant and category capture", () => {
  it("preserves raw description and maps explicit merchant/category columns", () => {
    const rows = parseCsv("Date,Description,Amount,Merchant,Category\n2026-09-01,AMZN MKTP DE*XYZ,-12.99,Amazon EU,Shopping");
    const mapped = mapRows(rows, { ...base, merchantColumn: "Merchant", categoryColumn: "Category" });
    expect(mapped[0].description).toBe("AMZN MKTP DE*XYZ");
    expect(mapped[0].merchant).toBe("Amazon EU");
    expect(mapped[0].category).toBe("Shopping");
  });

  it("canonicalizes explicit merchants and infers only high-confidence names", () => {
    expect(resolveMerchantName("Amazon EU", "AMZN MKTP DE*XYZ")).toBe("Amazon");
    expect(resolveMerchantName("Corner Bakery", "Corner Bakery croissant")).toBe("Corner Bakery");
    expect(resolveMerchantName("  AMZN MKTP DE  ", "AMZN MKTP DE")).toBe("Amazon");
    expect(resolveMerchantName(undefined, "AMZN MKTP DE purchase")).toBe("Amazon");
    expect(resolveMerchantName(undefined, "Spotify monthly")).toBe("Spotify");
    expect(resolveMerchantName(undefined, "Corner bakery croissant")).toBeNull();
    expect(resolveMerchantName("", "Corner bakery croissant")).toBeNull();
  });

  it("requires word boundaries for merchant inference", () => {
    expect(resolveMerchantName(undefined, "Superuber trip")).toBeNull();
    expect(resolveMerchantName(undefined, "Amazonium store")).toBeNull();
    expect(resolveMerchantName("Superuber", "Superuber trip")).toBe("Superuber");
    expect(resolveMerchantName("Amazonium", "Amazonium store")).toBe("Amazonium");
    expect(resolveMerchantName(undefined, "Uber trip")).toBe("Uber");
    expect(resolveMerchantName(undefined, "UBER *TRIP")).toBe("Uber");
    expect(resolveMerchantName(undefined, "AMZN MKTP DE*XYZ")).toBe("Amazon");
  });
  it("creates categories only from explicit source values", () => {
    expect(normalizeCategoryName("Groceries")).toBe("Groceries");
    expect(normalizeCategoryName("  ")).toBeNull();
    expect(normalizeCategoryName(undefined)).toBeNull();
    expect(normalizeCategoryName("x".repeat(101))).toBeNull();
  });
  it("retains source categories within the Unicode character limit", () => {
    const category = "🛒".repeat(100);
    expect(normalizeCategoryName(category)).toBe(category);
    expect(normalizeCategoryName("🛒".repeat(101))).toBeNull();
    const original = { Date: "2026-10-09", Description: "Synthetic purchase", Amount: "-1.00", Category: category };
    const [mapped] = mapRows([original], { ...base, categoryColumn: "Category" });
    expect(importRowPayload("workspace", "import", mapped)).toMatchObject({ categoryName: category, originalRow: original });
  });
});
