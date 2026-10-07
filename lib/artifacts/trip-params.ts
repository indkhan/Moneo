import { addTripDays, tripCostMinor, tripScenarioSchema, type TripScenario } from "@/lib/finance/trip-scenario";
import { z } from "zod";

export function tripStateForScenario(state: Record<string, unknown>, scenario: TripScenario, currencyCode: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...state, tripScenario: scenario };
  const cost = tripCostMinor(scenario, currencyCode);
  if (cost === null) delete next.costMinor;
  else next.costMinor = cost <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cost) : cost.toString();
  // A single same-currency cost can round-trip through generated scalar inputs.
  const payment = scenario.payments[0];
  if (scenario.payments.length === 1 && payment.kind === "cost" && !payment.fx && payment.currencyCode === currencyCode) {
    next.tripDate = scenario.startsOn;
    next.accountId = payment.accountId;
  } else {
    delete next.tripDate;
    delete next.accountId;
  }
  return next;
}

export function tripScenarioForParams(scenario: TripScenario, params: Record<string, string | number>, currencyCode = scenario.payments[0].currencyCode): TripScenario {
  const hasCost = params.costMinor !== undefined;
  const cost = hasCost ? z.string().regex(/^\d{1,18}$/).parse(String(params.costMinor)) : undefined;
  const date = params.tripDate ? z.iso.date().parse(params.tripDate) : scenario.startsOn;
  const accountId = params.accountId ? z.string().min(1).max(100).parse(params.accountId) : undefined;
  const simple = scenario.payments.length === 1 && scenario.payments[0].kind === "cost" && !scenario.payments[0].fx && scenario.payments[0].currencyCode === currencyCode;
  if (!simple) {
    const total = tripCostMinor(scenario, currencyCode);
    if ((hasCost && (total === null || BigInt(cost!) !== total)) || date !== scenario.startsOn || (accountId && scenario.payments.filter(item => item.kind === "cost").some(item => item.accountId !== accountId)))
      throw new Error("Edit the native dated budget for multiple payments, contributions or currency conversion; no single debit can replace it");
    return tripScenarioSchema.parse(scenario);
  }
  const shift = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${scenario.startsOn}T00:00:00Z`)) / 86400000);
  return tripScenarioSchema.parse({ ...scenario, startsOn: date, endsOn: addTripDays(scenario.endsOn, shift),
    payments: scenario.payments.map(item => ({ ...item, date: addTripDays(item.date, shift), accountId: accountId ?? item.accountId, amountMinor: cost ?? item.amountMinor })) });
}
