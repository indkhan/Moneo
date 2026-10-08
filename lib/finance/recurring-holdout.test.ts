import {expect, it} from "vitest";
import {detectRecurring, type RecurringTransaction} from "./recurring";

// Fixed synthetic holdout. Keep these cases separate from pattern-development fixtures;
// results describe this set only, never provider quality or calibrated probability.
const holdout = [
  {name: "references", recurring: true, cadence: "monthly", dates: ["2025-08-12", "2025-09-12", "2025-10-12"], labels: ["Service ref A1", "Service ref A2", "Service ref A3"]},
  {name: "extra purchase", recurring: true, cadence: "monthly", dates: ["2025-08-10", "2025-08-19", "2025-09-10", "2025-10-10"], amounts: [-2000n, -2010n, -2000n, -2000n]},
  {name: "missing source month", recurring: true, cadence: "monthly", dates: ["2025-01-31", "2025-02-28", "2025-04-30", "2025-05-31"]},
  {name: "holiday month end", recurring: true, cadence: "monthly", dates: ["2025-01-31", "2025-02-27", "2025-03-30"]},
  {name: "quarterly", recurring: true, cadence: "quarterly", dates: ["2024-10-31", "2025-01-31", "2025-04-30"]},
  {name: "annual leap", recurring: true, cadence: "yearly", dates: ["2024-02-29", "2025-02-28", "2026-02-28"]},
  {name: "fortnight", recurring: true, cadence: "biweekly", dates: ["2025-07-04", "2025-07-18", "2025-08-01"]},
  {name: "weekly discretionary groceries", recurring: false, dates: ["2025-09-05", "2025-09-12", "2025-09-19", "2025-09-26"], amounts: [-4200n, -4400n, -4100n, -4300n]},
  {name: "monthly discretionary retail", recurring: false, dates: ["2025-07-01", "2025-08-01", "2025-09-01"], amounts: [-2500n, -2400n, -2500n]},
  {name: "irregular discretionary retail", recurring: false, dates: ["2025-06-03", "2025-06-06", "2025-08-22", "2025-11-17"], amounts: [-2000n, -1900n, -8000n, -3500n]},
  {name: "same-day discretionary", recurring: false, dates: ["2025-06-01", "2025-06-01", "2025-06-01"]},
  {name: "different numeric merchants", recurring: false, dates: ["2025-06-01", "2025-07-01", "2025-08-01"], labels: ["Shop 101", "Shop 202", "Shop 303"]},
];

it("records observed holdout candidates and discretionary review burden without a quality claim", () => {
  const results = holdout.map(fixture => {
    const rows: RecurringTransaction[] = fixture.dates.map((date, index) => ({id: `${fixture.name}-${index}`, date,
      description: fixture.labels?.[index] ?? fixture.name, amountMinor: fixture.amounts?.[index] ?? -2000n,
      accountId: "synthetic-cash", currencyCode: "EUR"}));
    const candidates = detectRecurring(rows);
    if (fixture.recurring) expect(candidates.some(candidate => candidate.cadence === fixture.cadence), fixture.name).toBe(true);
    return {name: fixture.name, recurring: fixture.recurring, candidates: candidates.length, evidenceRows: candidates.reduce((sum, candidate) => sum + candidate.occurrences, 0)};
  });
  const falsePositiveCases = results.filter(result => !result.recurring && result.candidates > 0);
  // This detector cannot infer purchase intent from dates/amounts. The holdout proves that limitation.
  expect(falsePositiveCases.map(result => result.name)).toEqual(["weekly discretionary groceries", "monthly discretionary retail"]);
  console.info("MNE014 SYNTHETIC HOLDOUT", JSON.stringify({cases: results.length, recurringCases: 7, discretionaryCases: 5,
    falsePositiveCases: falsePositiveCases.length, reviewCandidates: results.reduce((sum, result) => sum + result.candidates, 0),
    reviewEvidenceRows: results.reduce((sum, result) => sum + result.evidenceRows, 0), results}));
});
