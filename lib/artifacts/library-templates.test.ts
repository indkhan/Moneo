import { expect, it } from "vitest";
import { LIBRARY_TEMPLATES } from "./library-templates";
import { validateGeneratedCandidate } from "./validate";
import { previewTemplate } from "./template-preview";
import { checkOutputShape } from "./output";
import { evaluateIsolated } from "./isolate";

const calculators = LIBRARY_TEMPLATES.filter(template => template.build);

it("offers the four requested templates", () => {
  expect(LIBRARY_TEMPLATES.map(template => template.name)).toEqual(["Budget tracker", "Trip planner", "Subscription audit", "Savings-rate calculator"]);
});

it.each(calculators.map(template => [template.id, template] as const))("%s passes the same server validation as user code", async (_id, template) => {
  const { source, manifest } = template.build!("2026-10-16");
  const result = await validateGeneratedCandidate({ kind: template.kind, source, manifest });
  expect(result).toMatchObject({ ok: true });
});

it.each(calculators.map(template => [template.id, template] as const))("%s preview runs in QuickJS and returns a valid output", async (_id, template) => {
  const output = await previewTemplate(template);
  expect(checkOutputShape(output)).toEqual([]);
  expect(output).toHaveProperty("summary");
});

it("subscription audit sums host merchant-month groups and labels them from records", async () => {
  const template = LIBRARY_TEMPLATES.find(item => item.id === "subscription-audit")!;
  const group = (merchant: string, month: string, currentMinor: string | null) => ({ dimensions: { merchant, month }, currency: "EUR", currentMinor });
  const investigation = { interpretedFilters: { period: { from: "2026-07-01", to: "2026-10-16" } }, coverage: { partial: false },
    groups: [group("m1", "2026-08", "1299"), group("m1", "2026-09", "1299"), group("m2", "2026-09", "5000"), group("m3", "2026-08", null), group("m3", "2026-09", "10")],
    records: { items: [{ merchantId: "m1", description: "Streaming" }] } };
  const output = await evaluateIsolated(template.build!("2026-10-16").source, { snapshot: { investigation }, params: { minMonths: 2 } }) as { rows: Record<string, unknown>[]; numbers: Record<string, unknown> };
  expect(output.rows).toEqual([{ merchant: "Streaming", currency: "EUR", monthsSeen: 2, averageMonthlyMinor: "1299", yearlyEstimateMinor: "15588" }]);
  expect(output.numbers).toEqual({ recurringMerchants: 1, yearlyEstimateMinor: "15588", currency: "EUR" });
});

it("budget tracker reports exact remaining budget", async () => {
  const template = LIBRARY_TEMPLATES.find(item => item.id === "budget-tracker")!;
  const output = await previewTemplate(template) as { numbers: Record<string, string> };
  // Fixture spending is 80000 minor units against the 150000 default budget.
  expect(output.numbers).toMatchObject({ spentMinor: "80000", remainingMinor: "70000", budgetUsed: "53.3%" });
});

it("savings-rate calculator derives the rate from host income and spending", async () => {
  const template = LIBRARY_TEMPLATES.find(item => item.id === "savings-rate")!;
  const output = await previewTemplate(template) as { numbers: Record<string, string> };
  expect(output.numbers).toMatchObject({ incomeMinor: "120000", spendingMinor: "80000", savedMinor: "40000", savingsRate: "33.3%", spendingLimitForTargetMinor: "96000" });
});

it("subscription audit fixes its investigation period from the creation date", () => {
  const template = LIBRARY_TEMPLATES.find(item => item.id === "subscription-audit")!;
  expect(template.build!("2026-10-16").manifest.investigation).toMatchObject({ period: { from: "2026-07-01", to: "2026-10-16" }, groupBy: ["merchant", "month"] });
});
