import { describe, expect, it } from "vitest";
import { isExplicitCategoryChange } from "./write-intent";

describe("explicit category change intent", () => {
  it("allows a direct request to change a category", () => {
    expect(isExplicitCategoryChange("Change my Amazon purchase to Groceries")).toBe(true);
    expect(isExplicitCategoryChange("Could you change the category to Groceries?" )).toBe(true);
  });

  it("does not enable writes for questions or suggestions", () => {
    expect(isExplicitCategoryChange("What category should I use for Amazon?")).toBe(false);
    expect(isExplicitCategoryChange("Maybe change Amazon to Groceries")).toBe(false);
    expect(isExplicitCategoryChange("We should change Amazon to Groceries")).toBe(false);
  });
});
