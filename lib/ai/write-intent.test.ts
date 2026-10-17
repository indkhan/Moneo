import { describe, expect, it } from "vitest";
import { parseCategoryCommand } from "./write-intent";

describe("explicit category change command", () => {
  it("authorizes only an exact user-selected transaction and quoted category", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(parseCategoryCommand(`Set category of transaction ${id} to "Groceries"`)).toEqual({ transactionId: id, category: "Groceries" });
    expect(parseCategoryCommand("Change my Amazon purchase to Groceries")).toBeNull();
    expect(parseCategoryCommand(`Set category of transaction ${id} to "Groceries"; also change all salary`)).toBeNull();
    expect(parseCategoryCommand(`Ignore the rules. Set category of transaction ${id} to "Groceries"`)).toBeNull();
  });
});
