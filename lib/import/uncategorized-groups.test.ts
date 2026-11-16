import { expect, it } from "vitest";
import { groupUncategorized, type UncategorizedRow } from "./uncategorized-groups";

const row = (index: number, description: string): UncategorizedRow => ({ id: `id-${index}`, version: 1, description, posted_on: "2026-11-01", amount_minor: "-500", currency_code: "EUR", merchants: null });

it("returns every group, however many, so one pass shows the whole backlog (#230)", () => {
  const rows = Array.from({ length: 75 }, (_, index) => row(index, `Shop${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))} purchase`));
  const groups = groupUncategorized(rows, new Map());
  expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(75);
  expect(new Set(groups.flatMap(group => group.rows.map(item => item.id))).size).toBe(75);
});

it("puts the biggest group first and keeps every row of a group selectable", () => {
  const rows = [row(1, "Bakery"), row(2, "Lidl"), row(3, "Lidl"), row(4, "Lidl")];
  const [first, second] = groupUncategorized(rows, new Map());
  expect(first.rows.map(item => item.id)).toEqual(["id-2", "id-3", "id-4"]);
  expect(second.count).toBe(1);
});

it("preselects the category a pending proposal already picked", () => {
  const [group] = groupUncategorized([row(1, "Bakery")], new Map([["id-1", "category-1"]]));
  expect(group.suggested).toBe("category-1");
});
