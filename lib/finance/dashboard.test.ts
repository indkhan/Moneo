import { expect, it } from "vitest";
import { cardIdFromKey, cardWidgetKey, dashboardItems, dashboardLayoutSchema, homeLayout, setWidget, sizeOptions, widgetSize, widgetSizesSchema } from "@/lib/finance/dashboard";

const id = "11111111-1111-4111-8111-111111111111";

it("ignores retired artifact widgets without rejecting the saved Home layout", () => {
  expect(dashboardLayoutSchema.parse(["overview", `artifact:${id}`, "accounts"])).toEqual(["overview", "accounts"]);
  expect(dashboardLayoutSchema.safeParse(["artifact:invalid"]).success).toBe(false);
});

it("keeps saved widget order and visibility and drops unknown widgets", () => {
  expect(dashboardItems(["unknown", "accounts", "accounts", "goals"])).toEqual(["accounts", "goals"]);
  expect(dashboardItems([])).toEqual([]);
  expect(dashboardItems(null)).toContain("overview");
  expect(dashboardLayoutSchema.safeParse(["constructor"]).success).toBe(false);
  expect(dashboardLayoutSchema.safeParse(["tool:11111111-1111-4111-8111-111111111111"]).success).toBe(false);
});

it("stores artifact cards beside built-in widgets", () => {
  const key = cardWidgetKey(id.toUpperCase());
  expect(key).toBe(`card:${id}`);
  expect(cardIdFromKey(key)).toBe(id);
  expect(cardIdFromKey("accounts")).toBeNull();
  expect(dashboardItems(["accounts", key, "card:nope"])).toEqual(["accounts", key]);
  expect(dashboardLayoutSchema.safeParse([key, "goals"]).success).toBe(true);
  expect(dashboardLayoutSchema.safeParse([key, key]).success).toBe(false);
});

it("pins a widget just below the overview and unpins it", () => {
  const key = cardWidgetKey(id);
  expect(setWidget(["overview", "spending"], key, true)).toEqual(["overview", key, "spending"]);
  expect(setWidget(["spending", "goals"], key, true)).toEqual([key, "spending", "goals"]);
  expect(setWidget(["overview", key], key, true)).toEqual(["overview", key]);
  expect(setWidget(["overview", key, "goals"], key, false)).toEqual(["overview", "goals"]);
});

it("keeps saved widget widths and drops unknown widgets or sizes too narrow for them", () => {
  expect(widgetSizesSchema.parse({ accounts: "L", overview: "S", goals: "XXL", unknown: "M", [`card:${id}`]: "S" })).toEqual({ accounts: "L" });
  expect(widgetSizesSchema.safeParse(["accounts"]).success).toBe(false);
  expect(widgetSize("accounts", {})).toBe("M");
  expect(widgetSize("accounts", { accounts: "XL" })).toBe("XL");
  expect(sizeOptions("overview")).toEqual(["L", "XL"]);
  expect(sizeOptions(cardWidgetKey(id))).toEqual(["S", "M", "L", "XL"]);
});

it("reads a saved layout row the way Home shows it", () => {
  expect(homeLayout(null)).toMatchObject({ version: 0, sizes: {} });
  expect(homeLayout(null)?.items).toContain("overview");
  expect(homeLayout({ items: ["goals", "accounts"], sizes: { goals: "XL", overview: "S" }, version: 7 })).toEqual({ items: ["goals", "accounts"], sizes: { goals: "XL" }, version: 7 });
  expect(homeLayout({ items: ["goals", "goals"], version: 2 })).toBeNull();
});
