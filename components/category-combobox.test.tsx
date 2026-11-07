import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CategoryCombobox, matchCategories, resolveCategory } from "./category-combobox";

const options = [{ id: "1", name: "Groceries" }, { id: "2", name: "Utilities" }, { id: "3", name: "Uber rides" }, { id: "4", name: "Eating out" }];

describe("category picker", () => {
  it("shows categories that start with the typed text first, then ones that contain it", () => {
    expect(matchCategories(options, "u").map(option => option.name)).toEqual(["Utilities", "Uber rides", "Eating out"]);
    expect(matchCategories(options, "  GRO ").map(option => option.name)).toEqual(["Groceries"]);
    expect(matchCategories(options, "")).toEqual(options);
    expect(matchCategories(options, "zzz")).toEqual([]);
  });

  it("resolves typed text to a category, a new name, or nothing", () => {
    expect(resolveCategory(options, "utilities")).toEqual({ id: "2" });
    expect(resolveCategory(options, " Pets ", true)).toEqual({ name: "Pets" });
    expect(resolveCategory(options, "Pets")).toBeNull();
    expect(resolveCategory(options, "  ", true)).toBeNull();
  });

  it("renders a combobox with the current text", () => {
    const html = renderToStaticMarkup(<CategoryCombobox label="Category" options={options} value="Groceries" onChange={() => {}} />);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('value="Groceries"');
  });
});
