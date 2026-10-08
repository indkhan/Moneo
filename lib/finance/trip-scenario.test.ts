import { expect, it } from "vitest";
import { accountLiquidity, forecastDaily, type ForecastInput } from "./calculations";
import { evaluateTripScenario, tripHorizon, tripScenarioSchema } from "./trip-scenario";

const scenario = { version: 1, destination: "Synthetic trip", startsOn: "2026-10-08", endsOn: "2026-10-08", postTripDays: 21,
  payments: [{ name: "Trip", kind: "cost", date: "2026-10-08", accountId: "a", currencyCode: "EUR", amountMinor: "20000" }] };
const input: ForecastInput = { startDate: "2026-10-01", horizonDays: 29, currencyCode: "EUR",
  accounts: [{ id: "a", currencyCode: "EUR", balanceMinor: 10000n }],
  events: [{ date: "2026-10-03", accountId: "a", expectedMinor: 100000n }] };

it("distinguishes the minimum before a salary-funded trip from the balance on the trip date", () => {
  const result = evaluateTripScenario(input, scenario);
  expect(result).toMatchObject({ horizon: { from: "2026-10-01", to: "2026-10-29", days: 29 },
    costMinor: "20000", contributionMinor: "0", netCostMinor: "20000", baselineAvailableMinor: "10000",
    withTripAvailableMinor: "10000", limitingDate: "2026-10-01", afterTripMinor: "90000" });
  expect(input.scenarioEvents).toBeUndefined();
});

it.each([
  ["minimum after trip", 100000n, "2026-10-03", 0n, 0n, 0n],
  ["salary after trip", 10000n, "2026-10-10", 100000n, 0n, 0n],
  ["negative funds", -50000n, "2026-10-03", 0n, 0n, 0n],
  ["holds", 100000n, "2026-10-03", 0n, 5000n, 0n],
  ["reservations", 100000n, "2026-10-03", 0n, 0n, 15000n],
  ["missing balance", null, "2026-10-03", 100000n, 0n, 0n],
] as const)("agrees with the shared engine for %s", (_, balanceMinor, date, salary, pendingHoldMinor, reservedMinor) => {
  const baseline = { ...input, accounts: [{ ...input.accounts[0], balanceMinor, pendingHoldMinor, reservedMinor }],
    events: [{ date, accountId: "a", expectedMinor: salary }] };
  const withTrip = { ...baseline, scenarioEvents: [{ date: "2026-10-08", accountId: "a", expectedMinor: -20000n, source: "scenario" as const, name: "Trip" }] };
  const engine = accountLiquidity(withTrip);
  const actual = evaluateTripScenario(baseline, scenario);
  expect(actual.tripLiquidity).toMatchObject({ status: engine.status });
  if (engine.status === "available") {
    expect(actual.withTripAvailableMinor).toBe(engine.accounts[0].spendableMinor.toString());
    expect(actual.limitingDate).toBe(engine.accounts[0].spendingLimitingDate);
    const daily = forecastDaily(withTrip);
    expect(daily.status).toBe("available");
  } else expect(actual.withTripAvailableMinor).toBeNull();
});

it("uses each payment and contribution date and paying account without inventing transfers", () => {
  const multi = { ...scenario, endsOn: "2026-10-11", payments: [scenario.payments[0],
    { ...scenario.payments[0], name: "Hotel", date: "2026-10-10", accountId: "b", amountMinor: "30000" },
    { ...scenario.payments[0], kind: "contribution", name: "Friend reimbursement", date: "2026-10-11", amountMinor: "10000" }] };
  const baseline = { ...input, horizonDays: 32, accounts: [...input.accounts, { id: "b", currencyCode: "EUR", balanceMinor: 10000n }] };
  const result = evaluateTripScenario(baseline, multi);
  expect(result).toMatchObject({ costMinor: "50000", contributionMinor: "10000", netCostMinor: "40000",
    tripLiquidity: { hasShortfall: true, accounts: [expect.anything(), { accountId: "b", shortfallMinor: "20000", firstShortfallDate: "2026-10-10" }] } });
});

it("requires bounded dates, explicit accounts/currencies and dated conversion provenance", () => {
  expect(tripHorizon("2026-10-01", scenario)).toEqual({ from: "2026-10-01", to: "2026-10-29", days: 29 });
  expect(() => tripHorizon("2026-10-09", scenario)).toThrow("past");
  expect(() => tripHorizon("2026-10-01", { ...scenario, startsOn: "2027-10-01", endsOn: "2027-10-01" })).toThrow("365");
  expect(() => tripScenarioSchema.parse({ ...scenario, payments: [{ ...scenario.payments[0], amountMinor: "1.2" }] })).toThrow();
  const foreign = { ...scenario, payments: [{ ...scenario.payments[0], currencyCode: "USD" }] };
  expect(evaluateTripScenario(input, foreign)).toMatchObject({ withTripAvailableMinor: null, unavailable: expect.stringContaining("rate:USD->EUR") });
  expect(evaluateTripScenario(input, { ...foreign, payments: [{ ...foreign.payments[0], fx: { rate: "0.5", date: "2026-10-01", source: "Manual trip assumption" } }] })).toMatchObject({ costMinor: "10000", afterTripMinor: "100000" });
});
