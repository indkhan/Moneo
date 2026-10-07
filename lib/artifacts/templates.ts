import { CALCULATOR_RUNTIME, type ArtifactKind } from "./spec";

// Deterministic hand-written fallback calculators. These are NOT AI output;
// they give the UI a known-safe starting point and keep tests offline.
// Each is a pure (input) => output function receiving { snapshot, params }.

export const FALLBACK_CALCULATORS: Record<ArtifactKind, { source: string; manifest: object; label: string }> = {
  ...Object.fromEntries(["custom_planner", "custom_tracker", "custom_report", "custom_comparison"].map(kind => [kind, {
    label: "Custom calculator starting point",
    source: `(input) => ({ summary: "Create a reviewed calculator for this tool", rows: [] })`,
    manifest: { kind, runtime: CALCULATOR_RUNTIME, sdk: [], params: {}, renderer: "trusted" },
  }])) as Record<"custom_planner" | "custom_tracker" | "custom_report" | "custom_comparison", { source: string; manifest: object; label: string }>,
  spending_explorer: {
    label: "Spending average (fallback)",
    source: `(input) => {
  const s = input && input.snapshot ? input.snapshot : {};
  if (s.unavailable) return { unavailable: s.unavailable };
  const spend = BigInt(s.spendingMinor || "0");
  const days = BigInt(Array.isArray(s.daily) && s.daily.length ? s.daily.length : 30);
  const avg = spend >= 0n ? (spend + days / 2n) / days : -((-spend + (days - 1n) / 2n) / days);
  const chartValues = (s.daily || []).slice(0, 14).map((d) => Number(d.spendingMinor || "0"));
  const exactChart = chartValues.every((v) => Number.isSafeInteger(v));
  return {
    summary: "Average " + String(avg) + " minor units/day over " + String(days) + " days.",
    numbers: { spendingMinor: s.spendingMinor || "0", averageMinorPerDay: String(avg) },
    warning: exactChart ? "" : "Chart unavailable beyond the exact numeric range; text amounts remain exact.",
    ...(exactChart ? { chart: {
      labels: (s.daily || []).slice(0, 14).map((d) => d.date),
      values: chartValues
    } } : {})
  };
}`,
    manifest: {
      kind: "spending_explorer",
      runtime: CALCULATOR_RUNTIME,
      sdk: ["spending", "cashflow"],
      params: {},
      renderer: "trusted",
    },
  },
  trip_planner: {
    label: "Dated trip headroom (fallback)",
    source: `(input) => {
  const s = input && input.snapshot ? input.snapshot : {};
  if (s.unavailable || s.baselineAvailableMinor === null || s.baselineAvailableMinor === undefined)
    return { unavailable: s.unavailable || "A dated balance in the display currency is required" };
  const params = input && input.params ? input.params : {};
  const cost = String(params.costMinor || 0);
  if (cost !== s.evaluatedCostMinor || s.withTripAvailableMinor === null || s.withTripAvailableMinor === undefined)
    return { unavailable: "Recalculate inputs to load the host's dated trip scenario for this cost." };
  if ((params.tripDate && params.tripDate !== s.tripDate) || (params.accountId && params.accountId !== s.accountId))
    return { unavailable: "Recalculate the dated trip inputs before using this forecast." };
  const rest = s.withTripAvailableMinor;
  return {
    summary: "Conservative minimum headroom over the dated trip horizon: " + String(rest) + " minor units; limited on " + String(s.limitingDate || "unknown") + ".",
    numbers: { baselineMinor: s.baselineAvailableMinor, costMinor: String(cost), minimumHeadroomMinor: rest,
      limitingDate: s.limitingDate || "unknown", horizonFrom: s.horizon ? s.horizon.from : "unknown", horizonTo: s.horizon ? s.horizon.to : "unknown",
      ...(s.afterTripMinor !== null && s.afterTripMinor !== undefined ? { afterTripMinor: s.afterTripMinor } : {}) },
    warning: "The horizon minimum is distinct from end-of-trip headroom. Hypothetical costs and external contributions do not change financial records; source completeness remains unknown."
  };
}`,
    manifest: {
      kind: "trip_planner",
      runtime: CALCULATOR_RUNTIME,
      sdk: ["balances", "forecast"],
      params: {
        costMinor: { type: "number", default: 90000, min: 0, max: 10000000, label: "Trip cost (minor units)" },
      },
      renderer: "trusted",
    },
  },
  goal_tracker: {
    label: "Goal pace (fallback)",
    source: `(input) => {
  const s = input && input.snapshot ? input.snapshot : {};
  if (s.unavailable && (!s.goals || s.goals.length === 0)) return { unavailable: s.unavailable || "No goals yet" };
  const extra = BigInt(input && input.params ? input.params.extraMonthlyMinor : 0);
  const rows = (s.goals || []).slice(0, 10).map((g) => {
    const remaining = g.remainingMinor === null || g.remainingMinor === undefined ? null : BigInt(g.remainingMinor);
    const months = remaining !== null && extra > 0n ? String((remaining + extra - 1n) / extra) : null;
    return { id: g.id, name: g.name, savedMinor: g.savedMinor, savedAsOf: g.savedAsOf, reservedMinor: g.reservedMinor, remainingMinor: g.remainingMinor, monthsAtExtraPace: months };
  });
  return { summary: rows.length + " goal(s) at illustrative pace.", warning: "Recorded dated savings are separate from virtual reservations. Unknown savings leave pace unavailable. Illustrative pace does not establish paying-account affordability; review dated account headroom in Plan.", rows, numbers: { extraMonthlyMinor: String(extra) } };
}`,
    manifest: {
      kind: "goal_tracker",
      runtime: CALCULATOR_RUNTIME,
      sdk: ["goals", "balances"],
      params: {
        extraMonthlyMinor: { type: "number", default: 10000, min: 0, max: 10000000, label: "Extra saving per month (minor units)" },
      },
      renderer: "trusted",
    },
  },
};
