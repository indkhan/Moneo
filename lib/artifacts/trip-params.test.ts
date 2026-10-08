import { expect, it } from "vitest";
import { tripScenarioForParams } from "./trip-params";
import { defaultTripScenario } from "@/lib/finance/trip-scenario";

it("changes cost, date and paying account while preserving named explicit assumptions", () => {
  const saved = { ...defaultTripScenario("2026-10-01", "EUR", "a", 20000n), destination: "Synthetic city" };
  expect(tripScenarioForParams(saved, { costMinor: "30000", tripDate: "2026-11-08", accountId: "b" })).toMatchObject({ destination: "Synthetic city", startsOn: "2026-11-08", endsOn: "2026-11-08", payments: [{ date: "2026-11-08", accountId: "b", amountMinor: "30000" }] });
  expect(saved.payments[0].amountMinor).toBe("20000");
});
it("does not collapse a dated multiple-payment budget into a single invented debit", () => {
  const base = defaultTripScenario("2026-10-01", "EUR", "a", 20000n);
  const saved = { ...base, payments: [...base.payments, { ...base.payments[0], name: "Hotel", date: "2026-10-09", amountMinor: "10000" }] };
  expect(tripScenarioForParams(saved, {})).toEqual(saved);
  expect(() => tripScenarioForParams(saved, { costMinor: 90000 })).toThrow("multiple");
});
it("compares converted cost totals without summing unrelated currency minor units", () => {
  const base = defaultTripScenario("2026-10-01", "EUR", "a", 20000n);
  const saved = { ...base, payments: [...base.payments, { ...base.payments[0], currencyCode: "USD", amountMinor: "40000", fx: { rate: "0.5", date: "2026-10-01", source: "Manual assumption" } }] };
  expect(tripScenarioForParams(saved, { costMinor: 40000 }, "EUR")).toEqual(saved);
  expect(() => tripScenarioForParams(saved, { costMinor: 60000 }, "EUR")).toThrow("multiple");
});
