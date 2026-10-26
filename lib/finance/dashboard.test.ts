import { expect, it } from "vitest";
import { artifactIdFromKey, artifactWidgetKey, dashboardItems, dashboardLayoutSchema, setWidget } from "@/lib/finance/dashboard";

const id = "11111111-1111-4111-8111-111111111111";

it("keeps saved widget order and visibility and drops unknown widgets", () => {
  expect(dashboardItems(["unknown", "accounts", "accounts", "goals"])).toEqual(["accounts", "goals"]);
  expect(dashboardItems([])).toEqual([]);
  expect(dashboardItems(null)).toContain("overview");
  expect(dashboardLayoutSchema.safeParse(["constructor"]).success).toBe(false);
  expect(dashboardLayoutSchema.safeParse(["tool:11111111-1111-4111-8111-111111111111"]).success).toBe(false);
});

it("stores pinned artifacts beside built-in widgets", () => {
  const key = artifactWidgetKey(id.toUpperCase());
  expect(key).toBe(`artifact:${id}`);
  expect(artifactIdFromKey(key)).toBe(id);
  expect(artifactIdFromKey("accounts")).toBeNull();
  expect(dashboardItems(["accounts", key, "artifact:nope"])).toEqual(["accounts", key]);
  expect(dashboardLayoutSchema.safeParse([key, "goals"]).success).toBe(true);
  expect(dashboardLayoutSchema.safeParse([key, key]).success).toBe(false);
});

it("pins a widget just below the overview and unpins it", () => {
  const key = artifactWidgetKey(id);
  expect(setWidget(["overview", "spending"], key, true)).toEqual(["overview", key, "spending"]);
  expect(setWidget(["spending", "goals"], key, true)).toEqual([key, "spending", "goals"]);
  expect(setWidget(["overview", key], key, true)).toEqual(["overview", key]);
  expect(setWidget(["overview", key, "goals"], key, false)).toEqual(["overview", "goals"]);
});
