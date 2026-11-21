import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CategoryCombobox, listPlacement, matchCategories, resolveCategory } from "./category-combobox";

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

  it("opens the list upward when the input is near the bottom of the screen", () => {
    expect(listPlacement({ top: 460, bottom: 500, left: 90, width: 280 }, 600)).toMatchObject({ position: "fixed", bottom: 144, left: 90, width: 280, maxHeight: 224 });
    expect(listPlacement({ top: 100, bottom: 140, left: 90, width: 280 }, 600)).toMatchObject({ top: 144, maxHeight: 224 });
  });

  it("shrinks the list to the room that is left when neither side fits it", () => {
    expect(listPlacement({ top: 100, bottom: 140, left: 0, width: 200 }, 300)).toMatchObject({ top: 144, maxHeight: 152 });
  });
});
