import { expect, it } from "vitest";
import { dashboardItems, dashboardLayoutSchema } from "@/lib/finance/dashboard";

it("keeps saved widget order and visibility and drops unknown widgets", () => {
  expect(dashboardItems(["unknown", "accounts", "accounts", "goals"])).toEqual(["accounts", "goals"]);
  expect(dashboardItems([])).toEqual([]);
  expect(dashboardItems(null)).toContain("overview");
  expect(dashboardLayoutSchema.safeParse(["constructor"]).success).toBe(false);
  expect(dashboardLayoutSchema.safeParse(["tool:11111111-1111-4111-8111-111111111111"]).success).toBe(false);
});
