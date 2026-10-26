import { expect, it } from "vitest";
import type { Insight } from "@/lib/finance/insights";
import { briefingFindings, keepsFacts, plainWording } from "./briefing";

const finding = { title: "Groceries spending increased", detail: "€412.00 in 2026-10-01–2026-10-25, compared with €349.00 in 2026-09-01–2026-09-25. Equal-length booked periods." };

it("accepts wording that keeps the finding's numbers and rejects any new or changed number", () => {
  expect(keepsFacts(finding, "Groceries are up: €412.00 so far this month against €349.00 by 25 Sep.")).toBe(true);
  expect(keepsFacts(finding, "Groceries are 18% above last month at €412.00.")).toBe(false);
  expect(keepsFacts(finding, "Groceries reached €413.00.")).toBe(false);
  expect(keepsFacts(finding, "Up from €349.00 by 5 Sep.")).toBe(false);
  expect(keepsFacts(finding, " ")).toBe(false);
});

it("keeps only important findings worth a briefing and has a plain fallback", () => {
  const insight = (type: Insight["type"], priority: Insight["priority"] = "important") => ({ ...finding, key: type, type, priority }) as Insight;
  expect(briefingFindings([insight("data_quality"), insight("upcoming_obligations"), insight("budget_pressure"), insight("goal_progress", "context"), insight("cash_shortfall")]).map(item => item.type))
    .toEqual(["budget_pressure", "cash_shortfall"]);
  expect(plainWording(finding)).toBe("Groceries spending increased. €412.00 in 2026-10-01–2026-10-25, compared with €349.00 in 2026-09-01–2026-09-25.");
});
