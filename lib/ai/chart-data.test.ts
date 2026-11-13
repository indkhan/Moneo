import { expect, it } from "vitest";
import { monthEnd, monthRange, topWithOther } from "./chart-data";

it("lists every month across a year boundary and ends the current month today", () => {
  expect(monthRange("2025-11-14", "2026-02-01")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  expect(monthEnd("2024-02", "2026-11-13")).toBe("2024-02-29");
  expect(monthEnd("2026-11", "2026-11-13")).toBe("2026-11-13");
});

it("folds the smallest groups into Other without changing the total", () => {
  const groups = ["a", "b", "c", "d"].map((label, index) => ({ label, amount: BigInt(`9007199254740993${index}`) }));
  const top = topWithOther(groups, 3, amount => ({ label: "Other", amount }));
  expect(top.map(group => group.label)).toEqual(["d", "c", "Other"]);
  expect(top.reduce((sum, group) => sum + group.amount, 0n)).toBe(groups.reduce((sum, group) => sum + group.amount, 0n));
});

