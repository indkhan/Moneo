import { CALCULATOR_RUNTIME, type ArtifactKind } from "./spec";

// Deterministic hand-written fallback calculators. These are NOT AI output;
// they give the UI a known-safe starting point and keep tests offline.
// Each is a pure (input) => output function receiving { snapshot, params }.

export const FALLBACK_CALCULATORS: Record<ArtifactKind, { source: string; manifest: object; label: string }> = {
  spending_explorer: {
    label: "Spending average (fallback)",
    source: `(input) => {
  const s = input && input.snapshot ? input.snapshot : {};
  if (s.unavailable) return { unavailable: s.unavailable };
  const spend = Number(s.spendingMinor || "0");
  const days = Array.isArray(s.daily) && s.daily.length ? s.daily.length : 30;
  const avg = Math.round(spend / days);
  return {
    summary: "Average " + String(avg) + " minor units/day over " + String(days) + " days.",
    numbers: { spendingMinor: s.spendingMinor || "0", averageMinorPerDay: String(avg) },
    chart: {
      labels: (s.daily || []).slice(0, 14).map((d) => d.date),
      values: (s.daily || []).slice(0, 14).map((d) => Number(d.spendingMinor || "0"))
    }
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
    label: "Trip remainder (fallback)",
    source: `(input) => {
  const s = input && input.snapshot ? input.snapshot : {};
  if (s.unavailable || s.baselineAvailableMinor === null || s.baselineAvailableMinor === undefined)
    return { unavailable: s.unavailable || "A dated balance in the display currency is required" };
  const base = Number(s.baselineAvailableMinor || "0");
  const cost = Number(input && input.params ? input.params.costMinor : 0);
  const rest = base - cost;
  return {
    summary: "Remaining after trip: " + String(rest) + " minor units.",
    numbers: { baselineMinor: s.baselineAvailableMinor, costMinor: String(cost), remainingMinor: String(rest) }
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
  const extra = Number(input && input.params ? input.params.extraMonthlyMinor : 0);
  const rows = (s.goals || []).slice(0, 10).map((g) => {
    const remaining = Number(g.remainingMinor || "0");
    const months = extra > 0 ? Math.ceil(remaining / extra) : -1;
    return { id: g.id, name: g.name, remainingMinor: g.remainingMinor, monthsAtExtraPace: months };
  });
  return { summary: rows.length + " goal(s) at illustrative pace.", rows, numbers: { extraMonthlyMinor: String(extra) } };
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
