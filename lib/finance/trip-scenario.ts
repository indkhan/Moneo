import { z } from "zod";
import { accountLiquidity, forecastDaily, serializeAccountLiquidity, type ForecastInput } from "./calculations";
import { convertFx, minorDigits } from "./fx";

const currency = z.string().regex(/^[A-Z]{3}$/).refine(code => { try { minorDigits(code); return true; } catch { return false; } }, "Unknown currency");
const payment = z.object({
  name: z.string().trim().min(1).max(120), kind: z.enum(["cost", "contribution"]), date: z.iso.date(),
  accountId: z.string().min(1).max(100), currencyCode: currency,
  amountMinor: z.string().regex(/^\d{1,18}$/).transform(value => BigInt(value).toString()),
  fx: z.object({ rate: z.string().regex(/^\d{1,18}(\.\d{1,18})?$/).refine(value => /[1-9]/.test(value), "Rate must be positive"),
    date: z.iso.date(), source: z.string().trim().min(1).max(120) }).strict().optional(),
}).strict().refine(value => !value.fx || value.fx.date <= value.date, "Rate date must not follow the payment date");

export const tripScenarioSchema = z.object({
  version: z.literal(1), destination: z.string().trim().max(120), startsOn: z.iso.date(), endsOn: z.iso.date(),
  postTripDays: z.number().int().min(0).max(90), payments: z.array(payment).min(1).max(50),
}).strict().refine(value => value.startsOn <= value.endsOn, "Trip end must not precede its start");
export type TripScenario = z.infer<typeof tripScenarioSchema>;

export function addTripDays(date: string, days: number) {
  z.iso.date().parse(date);
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

// All intervening obligations remain in the horizon, starting from the dated current balance.
export function tripHorizon(today: string, raw: unknown) {
  z.iso.date().parse(today);
  const scenario = tripScenarioSchema.parse(raw);
  if (scenario.startsOn < today || scenario.payments.some(item => item.date < today)) throw new Error("Trip or payment date is in the past; choose future hypothetical dates");
  const lastDate = [scenario.endsOn, ...scenario.payments.map(item => item.date)].sort().at(-1)!;
  const to = addTripDays(lastDate, scenario.postTripDays);
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000) + 1;
  if (days > 365) throw new Error("Trip horizon must fit within 365 days of current balance evidence");
  return { from: today, to, days };
}

export function defaultTripScenario(today: string, currencyCode: string, accountId: string, costMinor: bigint): TripScenario {
  const date = addTripDays(today, 7);
  return tripScenarioSchema.parse({ version: 1, destination: "", startsOn: date, endsOn: date, postTripDays: 21,
    payments: [{ name: "Trip", kind: "cost", date, accountId, currencyCode, amountMinor: costMinor.toString() }] });
}

export function evaluateTripScenario(input: ForecastInput, raw: unknown) {
  const scenario = tripScenarioSchema.parse(raw), horizon = tripHorizon(input.startDate, scenario);
  if (input.horizonDays < horizon.days) throw new Error("Forecast evidence does not cover the trip horizon");
  const baselineInput = { ...input, horizonDays: horizon.days };
  const missing: string[] = [];
  let costMinor = 0n, contributionMinor = 0n;
  const events = scenario.payments.flatMap(item => {
    if (!input.accounts.some(account => account.id === item.accountId)) { missing.push(`account:${item.accountId}`); return []; }
    const converted = convertFx({ amountMinor: BigInt(item.amountMinor), from: item.currencyCode, to: input.currencyCode,
      rate: item.fx?.rate, date: item.fx?.date ?? item.date, source: item.fx?.source ?? "Same currency trip assumption" });
    if (converted.status === "unavailable") { missing.push(...converted.missingInputs); return []; }
    const amount = converted.converted.amountMinor;
    if (item.kind === "cost") costMinor += amount; else contributionMinor += amount;
    return [{ date: item.date, accountId: item.accountId, expectedMinor: item.kind === "cost" ? -amount : amount,
      source: "scenario" as const, name: item.name }];
  });
  const withTripInput = { ...baselineInput, missingInputs: [...(baselineInput.missingInputs ?? []), ...missing],
    scenarioEvents: [...(baselineInput.scenarioEvents ?? []), ...events] };
  const baseline = accountLiquidity(baselineInput), trip = accountLiquidity(withTripInput);
  const payingIds = [...new Set(scenario.payments.filter(item => item.kind === "cost").map(item => item.accountId))];
  const selected = (result: typeof baseline) => result.status === "available"
    ? result.accounts.filter(account => payingIds.includes(account.accountId)).reduce<typeof result.accounts[number] | null>((lowest, account) => !lowest || account.spendableMinor < lowest.spendableMinor ? account : lowest, null) : null;
  const before = selected(baseline), after = selected(trip);
  const days = forecastDaily(withTripInput);
  const tripDay = days.status === "available" ? days.days.find(day => day.date === scenario.endsOn) : undefined;
  const account = payingIds.length === 1 ? input.accounts.find(item => item.id === payingIds[0]) : undefined;
  const protectedMinor = account ? (account.reservedMinor ?? 0n) + (account.safetyBufferMinor ?? 0n) + (account.minimumMinor ?? 0n) : null;
  const aggregateProtection = (input.workspaceBufferMinor ?? 0n) + input.accounts.reduce((sum, item) => sum + (item.reservedMinor ?? 0n) + (item.safetyBufferMinor ?? 0n) + (item.minimumMinor ?? 0n), 0n);
  const datedAccount = tripDay && account && protectedMinor !== null ? tripDay.conservativeByAccount[account.id] - protectedMinor : null;
  const datedAggregate = tripDay ? tripDay.conservativeMinor - aggregateProtection : null;
  const afterTripMinor = datedAccount !== null && datedAggregate !== null ? (datedAccount < datedAggregate ? datedAccount : datedAggregate).toString() : null;
  return { scenario, horizon, currency: input.currencyCode, accountId: payingIds.length === 1 && input.accounts.some(item => item.id === payingIds[0]) ? payingIds[0] : null,
    costMinor: missing.length ? null : costMinor.toString(), contributionMinor: missing.length ? null : contributionMinor.toString(),
    netCostMinor: missing.length ? null : (costMinor - contributionMinor).toString(),
    baselineAvailableMinor: before?.spendableMinor.toString() ?? null, withTripAvailableMinor: after?.spendableMinor.toString() ?? null,
    limitingDate: after?.spendingLimitingDate ?? null, baselineLimitingDate: before?.spendingLimitingDate ?? null,
    afterTripMinor, afterTripDate: scenario.endsOn,
    liquidity: serializeAccountLiquidity(baseline), tripLiquidity: serializeAccountLiquidity(trip),
    unavailable: trip.status === "unavailable" ? `Forecast unavailable: ${trip.missingInputs.join(", ")}` : !after ? "Choose a paying account; aggregate cash requires explicit funding" : null,
    assumptions: ["Hypothetical costs and external contributions; no account, goal, transaction or reservation is changed.",
      "Confirmed obligations, outstanding holds, reservations and buffers use the shared forecast engine.",
      "Headroom is the conservative minimum over the entire dated horizon; end-of-trip headroom is a separate dated metric.",
      ...(scenario.payments.some(item => item.kind === "contribution") ? ["Contributions are assumed external receipts on their dates, not transfers between your accounts."] : [])] };
}
export type TripScenarioResult = ReturnType<typeof evaluateTripScenario>;
