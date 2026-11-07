import { describe, expect, it } from "vitest";
import { detectRecurring, type RecurringTransaction } from "./recurring";

const day = 86400000;
function series(prefix: string, start: string, stepDays: number, count: number, description: string): RecurringTransaction[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index}`, date: new Date(Date.parse(start) + index * stepDays * day).toISOString().slice(0, 10),
    description, amountMinor: -1500n, currencyCode: "EUR", accountId: "checking",
  }));
}
function monthly(prefix: string, months: string[], description: string): RecurringTransaction[] {
  return months.map((date, index) => ({ id: `${prefix}${index}`, date, description, amountMinor: -1500n, currencyCode: "EUR", accountId: "checking" }));
}
const cadences = (rows: RecurringTransaction[]) => detectRecurring(rows).map(item => item.cadence);

// Short cadences fit by chance more easily, so they need more payments before Moneo suggests them.
describe("recurring minimum evidence", () => {
  it("needs 5 bi-weekly payments", () => {
    expect(cadences(series("b", "2026-01-02", 14, 3, "Cleaner"))).toEqual([]);
    expect(cadences(series("b", "2026-01-02", 14, 4, "Cleaner"))).toEqual([]);
    expect(cadences(series("b", "2026-01-02", 14, 5, "Cleaner"))).toEqual(["biweekly"]);
  });

  it("needs 6 weekly payments", () => {
    expect(cadences(series("w", "2026-01-02", 7, 5, "Gym"))).toEqual([]);
    expect(cadences(series("w", "2026-01-02", 7, 6, "Gym"))).toEqual(["weekly"]);
  });

  it("keeps 3 monthly, quarterly or yearly payments", () => {
    expect(cadences(monthly("m", ["2026-01-02", "2026-02-02", "2026-03-02"], "Rent"))).toEqual(["monthly"]);
    expect(cadences(monthly("q", ["2025-01-10", "2025-04-10", "2025-07-10"], "Insurance"))).toEqual(["quarterly"]);
    expect(cadences(monthly("y", ["2024-03-01", "2025-03-01", "2026-03-01"], "Domain"))).toEqual(["yearly"]);
  });

  it("does not call 2 payments recurring", () => {
    expect(cadences(monthly("x", ["2026-01-02", "2026-02-02"], "Shop"))).toEqual([]);
    expect(cadences(monthly("z", ["2025-03-01", "2026-03-01"], "Domain"))).toEqual([]);
  });
});
