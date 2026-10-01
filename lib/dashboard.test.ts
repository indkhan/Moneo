import { expect, it } from "vitest";
import { dashboardItems, dashboardLayoutSchema } from "./dashboard";

it("keeps saved widget order and visibility, removes unpinned tools and appends newly pinned tools", () => {
  const one = "11111111-1111-4111-8111-111111111111";
  const two = "22222222-2222-4222-8222-222222222222";
  expect(dashboardItems([`tool:${one}`, "accounts", "accounts"], [two])).toEqual(["accounts", `tool:${two}`]);
  expect(dashboardItems([], [])).toEqual([]);
  expect(dashboardItems(null, [one])).toContain(`tool:${one}`);
  expect(dashboardLayoutSchema.safeParse(["constructor"]).success).toBe(false);
});
