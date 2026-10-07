import { resolveBalances } from "@/lib/finance/balances";
import { SNAPSHOT_LIMITS, evidenceCoverage } from "./coverage";
import type { ArtifactKind } from "./spec";
import type { CalculatorInput } from "./validate";
import { buildSourceCoverage } from "@/lib/finance/source-coverage";

function spending(currency = "EUR", amount = "80000", partial = false, from = "2026-09-01", days = 30) {
  const to = `${from.slice(0, 8)}${String(days).padStart(2, "0")}`;
  return { currency, from, to, sourceCoverage: buildSourceCoverage({ from, to, currencyCode: currency }, []), spendingMinor: amount, incomeMinor: "120000", netMinor: (120000n - BigInt(amount)).toString(),
    daily: Array.from({ length: days }, (_, index) => ({ date: `${from.slice(0, 8)}${String(index + 1).padStart(2, "0")}`, spendingMinor: index ? "0" : amount })),
    partial, excludedReviewRows: partial ? 2 : 0,
    byAccount: [{ id: "a", incomeMinor: "120000", spendingMinor: amount, netMinor: (120000n - BigInt(amount)).toString(), partial, excludedReviewRows: partial ? 2 : 0 }] };
}

function goal(savedMinor: string | null = "2500", currency = "EUR") {
  return { id: "g", name: "Synthetic goal", currency, targetMinor: "10000", savedMinor, savedAsOf: savedMinor === null ? null : "2026-09-01", reservedMinor: "1000", remainingMinor: savedMinor === null ? null : "7500", reservedRemainingMinor: "9000", plannedMonthlyMinor: "500", contributionStartsOn: null };
}

function balances(status: "current" | "missing" | "stale" | "ambiguous" = "current", currency = "EUR", amount = "150000") {
  const asOf = "2026-09-30T00:00:00Z";
  const snapshot = { account_id: "a", amount_minor: amount, currency_code: currency, as_of: asOf, provenance: "Synthetic fixture" };
  return resolveBalances([{ id: "a", name: "Synthetic cash", currency_code: currency, type: "cash", archived_at: null }],
    status === "missing" ? [] : status === "ambiguous" ? [snapshot, { ...snapshot, amount_minor: "150001" }] : [snapshot], [],
    status === "stale" ? "2026-10-01T00:00:00Z" : asOf);
}

// The quickjs-calculator-v1 contract exposes only requested custom operations.
// The host can omit any failed operation while retaining other valid evidence.
export function snapshotFixtures(kind: ArtifactKind, sdk: string[]): CalculatorInput[] {
  if (kind.startsWith("custom_")) {
    const operations = [...new Set(sdk)];
    const normal: Record<string, unknown> = { currency: operations.length ? "EUR" : "" };
    const sources = Object.fromEntries(operations.map(operation => [operation, buildSourceCoverage({ from: "2026-09-01", to: "2026-09-30",
      ...(operation === "goals" ? { recordBasis: "manual_goals" as const } : operation === "balances" || operation === "forecast" ? { ledgerBasis: "balance_activity" as const } : { currencyCode: "EUR" }) }, [])]));
    for (const operation of operations) normal[operation] = operation === "balances" ? balances() : operation === "goals" ? [goal()] : operation === "forecast" ? { currency: "EUR", sourceCoverage: sources.forecast, baselineAvailableMinor: "150000", evaluatedCostMinor: "90000", withTripAvailableMinor: "60000", unavailable: null, tripDate: "2026-10-03" } : spending();
    if (operations.length) normal.sourceCoverageByOperation = sources;
    if (sdk.includes("spending") || sdk.includes("cashflow")) normal.sourceCoverage = sources.spending ?? sources.cashflow;
    if (sdk.includes("balances") || sdk.includes("goals")) normal.coverage = {
      ...(sdk.includes("balances") ? { balances: evidenceCoverage(1, "balances") } : {}),
      ...(sdk.includes("goals") ? { goals: evidenceCoverage(1, "goals") } : {}),
    };
    const fixtures: CalculatorInput[] = [{ snapshot: normal, params: {} }];
    const add = (snapshot: Record<string, unknown>) => fixtures.push({ snapshot, params: {} });
    const empty = structuredClone(normal);
    for (const op of operations) empty[op] = op === "balances" || op === "goals" ? [] : op === "forecast" ? { currency: "EUR", baselineAvailableMinor: null, unavailable: "No dated balance", tripDate: "2026-10-03" } : { ...spending("EUR", "0"), incomeMinor: "0", netMinor: "0", byAccount: [] };
    if (empty.coverage) empty.coverage = { ...(sdk.includes("balances") ? { balances: evidenceCoverage(0, "balances") } : {}), ...(sdk.includes("goals") ? { goals: evidenceCoverage(0, "goals") } : {}) };
    if (sdk.includes("goals") || sdk.includes("forecast")) empty.unavailable = "Requested evidence unavailable";
    add(empty);
    // Each subset of successfully loaded operations, including complete absence.
    for (let mask = 0; mask < (1 << operations.length) - 1; mask++) {
      const missing: Record<string, unknown> = { currency: mask ? "EUR" : "", unavailable: "Requested evidence unavailable" };
      operations.forEach((op, index) => {
        if (mask & (1 << index)) {
          missing[op] = structuredClone(normal[op]);
          if ((op === "balances" || op === "goals") && normal.coverage) missing.coverage = { ...(missing.coverage as object ?? {}), [op]: evidenceCoverage(1, op) };
        }
      });
      add(missing);
    }
    // Currency-conversion failures retain a present period without its metrics.
    for (const operation of operations.filter(op => op === "spending" || op === "cashflow")) {
      add({ ...structuredClone(normal), [operation]: { currency: "EUR", unavailable: "Some transactions require currency conversion" }, unavailable: `${operation}: Some transactions require currency conversion` });
    }
    const nullable = structuredClone(normal);
    if (sdk.includes("balances")) nullable.balances = balances("missing");
    if (sdk.includes("goals")) nullable.goals = [goal(null)];
    add(nullable);
    if (sdk.includes("balances")) for (const status of ["stale", "ambiguous"] as const) add({ ...structuredClone(normal), balances: balances(status) });
    const partial = structuredClone(normal);
    for (const op of operations.filter(op => op === "spending" || op === "cashflow")) partial[op] = spending("EUR", "80000", true);
    if (sdk.includes("spending") || sdk.includes("cashflow")) { partial.partial = true; partial.excludedReviewRows = 2; }
    add(partial);
    const huge = structuredClone(normal);
    for (const op of operations.filter(op => op === "spending" || op === "cashflow")) huge[op] = spending("EUR", "9007199254740993");
    if (sdk.includes("balances")) huge.balances = balances("current", "EUR", "9007199254740993");
    if (sdk.includes("forecast")) huge.forecast = { currency: "EUR", baselineAvailableMinor: "9007199254740993", evaluatedCostMinor: "0", withTripAvailableMinor: "9007199254740993", unavailable: null, tripDate: "2026-10-03" };
    add(huge);
    const capped = structuredClone(normal);
    if (sdk.includes("balances")) capped.balances = Array.from({ length: SNAPSHOT_LIMITS.balances }, (_, i) => ({ ...balances()[0], id: `a${i}` }));
    if (sdk.includes("goals")) capped.goals = Array.from({ length: SNAPSHOT_LIMITS.goals }, (_, i) => ({ ...goal(), id: `g${i}` }));
    if (capped.coverage) capped.coverage = { ...(sdk.includes("balances") ? { balances: evidenceCoverage(51, "balances") } : {}), ...(sdk.includes("goals") ? { goals: evidenceCoverage(21, "goals") } : {}) };
    for (const op of operations.filter(op => op === "spending" || op === "cashflow")) {
      const period = spending("EUR", "80000", false, "2026-08-01", 31);
      capped[op] = { ...period, byAccount: Array.from({length: 51}, (_, index) => ({ ...period.byAccount[0], id: `a${index}`, incomeMinor: index ? "0" : "120000", spendingMinor: index ? "0" : "80000", netMinor: index ? "0" : "40000" })) };
    }
    add(capped);
    const foreign = structuredClone(normal);
    foreign.currency = operations.length ? "USD" : "";
    for (const op of operations) {
      if (op === "balances") foreign.balances = [...balances(), ...balances("current", "USD").map(b => ({ ...b, id: "usd" }))];
      else if (op === "goals") foreign.goals = [goal("2500", "USD")];
      else foreign[op] = { ...(normal[op] as object), currency: "USD" };
    }
    if (sdk.includes("balances")) foreign.coverage = { ...(foreign.coverage as object), balances: evidenceCoverage(2, "balances") };
    add(foreign);
    return fixtures;
  }
  if (kind === "spending_explorer") return [
    { snapshot: spending(), params: {} },
    { snapshot: { ...spending("EUR", "0"), incomeMinor: "0", netMinor: "0", byAccount: [] }, params: {} },
    { snapshot: { currency: "EUR", unavailable: "Some transactions require currency conversion" }, params: {} },
    { snapshot: spending("USD", "9007199254740993", true), params: {} },
  ];
  if (kind === "trip_planner") return [
    { snapshot: { currency: "EUR", baselineAvailableMinor: "150000", evaluatedCostMinor: "90000", withTripAvailableMinor: "60000", unavailable: null, tripDate: "2026-10-03" }, params: { costMinor: 90000 } },
    { snapshot: { currency: "EUR", baselineAvailableMinor: "0", evaluatedCostMinor: "0", withTripAvailableMinor: "0", unavailable: null, tripDate: "2026-10-03" }, params: { costMinor: 0 } },
    { snapshot: { currency: "EUR", baselineAvailableMinor: null, unavailable: "A dated balance in the display currency is required", tripDate: "2026-10-03" }, params: { costMinor: 90000 } },
  ];
  return [
    { snapshot: { currency: "EUR", goals: [goal()], coverage: { goals: evidenceCoverage(1, "goals") } }, params: { extraMonthlyMinor: 10000 } },
    { snapshot: { currency: "EUR", goals: [], unavailable: "No goals yet" }, params: { extraMonthlyMinor: 0 } },
    { snapshot: { currency: "EUR", goals: [], unavailable: "Goal allocations require currency conversion" }, params: { extraMonthlyMinor: 10000 } },
    { snapshot: { currency: "USD", goals: [goal(null, "USD")], coverage: { goals: evidenceCoverage(1, "goals") } }, params: { extraMonthlyMinor: 10000 } },
    { snapshot: { currency: "EUR", goals: Array.from({ length: SNAPSHOT_LIMITS.goals }, (_, i) => ({ ...goal(), id: `g${i}` })), coverage: { goals: evidenceCoverage(21, "goals") } }, params: { extraMonthlyMinor: 10000 } },
  ];
}
