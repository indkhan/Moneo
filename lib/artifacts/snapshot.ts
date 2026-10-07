// Host-built snapshots for the generated calculator sandbox.
// Finance data comes ONLY from existing host-approved SDK operations
// (lib/artifacts/finance-sdk.ts + lib/finance/tools.ts). Generated code
// never queries the database; it receives one of these small JSON
// snapshots as input.snapshot plus artifact-local params.

import { balancesForArtifact, goalsForArtifact, spendingForArtifact, tripForArtifact } from "./finance-sdk";
import { SNAPSHOT_LIMITS, evidenceCoverage, type SnapshotCoverage } from "./coverage";
import { dailySpending } from "@/lib/finance/calculations";
import { calendarDate } from "@/lib/finance/calendar";
import { ALLOWED_SDK_BY_KIND, type ArtifactKind } from "./spec";
import type { SourceCoverage } from "@/lib/finance/source-coverage";

export type CalculatorSnapshot = { coverage?: SnapshotCoverage; sourceCoverage?: SourceCoverage; sourceCoverageByOperation?: Record<string, SourceCoverage> } & (
  | { currency: string; balances?: Awaited<ReturnType<typeof balancesForArtifact>>["balances"];
      spending?: CalculatorSnapshot; cashflow?: CalculatorSnapshot; goals?: unknown; forecast?: CalculatorSnapshot;
      partial?: boolean; excludedReviewRows?: number; unavailable?: string }
  | {
      currency: string;
      incomeMinor?: string;
      from?: string;
      to?: string;
      spendingMinor?: string;
      netMinor?: string;
      daily?: { date: string; spendingMinor: string }[];
      byAccount?: Awaited<ReturnType<typeof spendingForArtifact>>["byAccount"];
      unavailable?: string;
      partial?: boolean;
      excludedReviewRows?: number;
    }
  | {
      currency: string;
      baselineAvailableMinor?: string | null;
      withTripAvailableMinor?: string | null;
      evaluatedCostMinor?: string;
      unavailable?: string | null;
      tripDate?: string;
      accountId?: string | null;
      liquidity?: Awaited<ReturnType<typeof tripForArtifact>>["liquidity"];
      tripLiquidity?: Awaited<ReturnType<typeof tripForArtifact>>["tripLiquidity"];
    }
  | {
      currency: string;
      goals?: { id: string; name: string; currency: string; targetMinor: string; savedMinor: string | null; savedAsOf: string | null; reservedMinor: string; remainingMinor: string | null; reservedRemainingMinor: string; plannedMonthlyMinor: string; contributionStartsOn: string | null }[];
      unavailable?: string;
    });

export async function buildCalculatorSnapshot(
  artifactId: string,
  kind: ArtifactKind,
  opts?: { query?: string; month?: string; costMinor?: bigint; accountId?: string; funding?: Parameters<typeof tripForArtifact>[3]; sdk?: string[]; spendingOperation?: "spending" | "cashflow" },
): Promise<{ snapshot: CalculatorSnapshot; stateParams: Record<string, number | string> }> {
  if (kind.startsWith("custom_")) {
    const operations = [...new Set(opts?.sdk ?? [])];
    if (operations.some(operation => !ALLOWED_SDK_BY_KIND[kind].includes(operation))) throw new Error("Unauthorized custom snapshot operation");
    const snapshot: { currency: string; balances?: Awaited<ReturnType<typeof balancesForArtifact>>["balances"]; spending?: CalculatorSnapshot; cashflow?: CalculatorSnapshot;
      goals?: unknown; forecast?: CalculatorSnapshot; coverage?: SnapshotCoverage; sourceCoverage?: SourceCoverage; sourceCoverageByOperation?: Record<string, SourceCoverage>; partial?: boolean; excludedReviewRows?: number; unavailable?: string } = { currency: "" };
    const unavailable: string[] = [];
    for (const operation of operations) {
      try {
        if (operation === "balances") {
          const data = await balancesForArtifact(artifactId); snapshot.currency = data.currency; snapshot.balances = data.balances.slice(0, SNAPSHOT_LIMITS.balances);
          if (data.sourceCoverage) snapshot.sourceCoverageByOperation = { ...snapshot.sourceCoverageByOperation, balances: data.sourceCoverage };
          snapshot.coverage = { ...snapshot.coverage, balances: evidenceCoverage(data.balances.length, "balances") };
        } else {
          const legacyKind = operation === "goals" ? "goal_tracker" : operation === "forecast" ? "trip_planner" : "spending_explorer";
          const data = (await buildCalculatorSnapshot(artifactId, legacyKind, { ...opts, ...(operation === "cashflow" ? { spendingOperation: "cashflow" } : {}) })).snapshot;
          if (data.sourceCoverage) snapshot.sourceCoverageByOperation = { ...snapshot.sourceCoverageByOperation, [operation]: data.sourceCoverage };
          snapshot.currency ||= data.currency;
          if (operation === "goals") {
            snapshot.goals = "goals" in data ? data.goals : [];
            if (data.coverage) snapshot.coverage = { ...snapshot.coverage, ...data.coverage };
          }
          else if (operation === "forecast") snapshot.forecast = data;
          else {
            snapshot[operation as "spending" | "cashflow"] = data;
            if (data.sourceCoverage) snapshot.sourceCoverage = data.sourceCoverage;
            if ("partial" in data && data.partial) { snapshot.partial = true; snapshot.excludedReviewRows = data.excludedReviewRows; }
          }
          if (data.unavailable) unavailable.push(`${operation}: ${data.unavailable}`);
        }
      } catch (error) { unavailable.push(`${operation}: ${error instanceof Error ? error.message : "Evidence unavailable"}`); }
    }
    if (unavailable.length) snapshot.unavailable = unavailable.join("; ");
    return { snapshot, stateParams: {} };
  }
  if (kind === "spending_explorer") {
    const data = await spendingForArtifact(artifactId, opts?.query ?? "", opts?.spendingOperation ?? "spending", opts?.month);
    if ("unavailable" in data.summary) {
      return {
        snapshot: { currency: data.currency, unavailable: data.summary.unavailable, sourceCoverage: data.sourceCoverage },
        stateParams: {},
      };
    }
    return {
      snapshot: {
        currency: data.currency,
        sourceCoverage: data.sourceCoverage,
        from: data.from,
        to: data.to,
        incomeMinor: data.summary.incomeMinor,
        spendingMinor: data.summary.spendingMinor,
        netMinor: data.summary.netMinor,
        partial: data.summary.partial,
        excludedReviewRows: data.summary.excludedReviewRows,
        byAccount: data.byAccount,
        daily: dailySpending(data.transactions.map(row => ({ date: row.posted_on, amountMinor: BigInt(row.amount_minor), kind: row.kind })), data.from, data.to),
      },
      stateParams: {},
    };
  }
  if (kind === "trip_planner") {
    const data = await tripForArtifact(artifactId, opts?.costMinor ?? 90000n, opts?.accountId, opts?.funding);
    return {
      snapshot: {
        currency: data.currency,
        sourceCoverage: data.sourceCoverage,
        baselineAvailableMinor:
          data.baseline.status === "available" ? data.baseline.amountMinor.toString() : null,
        unavailable: data.unavailable ?? (data.baseline.status === "available" ? null : "Forecast unavailable"),
        withTripAvailableMinor: data.withTrip?.status === "available" ? data.withTrip.amountMinor.toString() : null,
        evaluatedCostMinor: (opts?.costMinor ?? 90000n).toString(),
        tripDate: data.tripDate,
        ...(data.liquidity ? { accountId: data.accountId, liquidity: data.liquidity, tripLiquidity: data.tripLiquidity } : {}),
      },
      stateParams: { costMinor: Number(opts?.costMinor ?? 90000n) },
    };
  }
  const data = await goalsForArtifact(artifactId);
  const balances = new Map(data.balances.map((b) => [b.id, b.currency_code]));
  const currencies = new Set(data.goals.map(goal => goal.currency_code));
  if (currencies.size > 1) {
    return { snapshot: { currency: data.currency, goals: [], sourceCoverage: data.sourceCoverage, unavailable: "Goals use different currencies; choose a single currency before comparing saving pace" }, stateParams: {} };
  }
  if (data.goals.some(goal => data.allocations.some(allocation => allocation.goal_id === goal.id && balances.get(allocation.account_id) !== goal.currency_code))) {
    return { snapshot: { currency: data.currency, goals: [], sourceCoverage: data.sourceCoverage, unavailable: "Goal allocations require currency conversion" }, stateParams: {} };
  }
  const goals = (data.goals ?? []).slice(0, SNAPSHOT_LIMITS.goals).map((g) => {
    const allocs = (data.allocations ?? []).filter((a) => a.goal_id === g.id);
    const reserved = allocs.reduce((s, a) => s + BigInt(a.amount_minor), 0n);
    const saved = g.recorded_saved_minor !== null && g.recorded_saved_minor !== undefined && g.saved_as_of && g.saved_as_of <= calendarDate(new Date(), data.timezone)
      ? BigInt(g.recorded_saved_minor) : null;
    const target = BigInt(g.target_minor);
    return {
      id: g.id,
      name: g.name,
      currency: g.currency_code,
      targetMinor: target.toString(),
      savedMinor: saved?.toString() ?? null,
      savedAsOf: g.saved_as_of ?? null,
      reservedMinor: reserved.toString(),
      remainingMinor: saved === null ? null : (target > saved ? target - saved : 0n).toString(),
      reservedRemainingMinor: (target > reserved ? target - reserved : 0n).toString(),
      plannedMonthlyMinor: g.planned_monthly_minor ?? "0",
      contributionStartsOn: g.contribution_starts_on ?? null,
    };
  });
  if (!goals.length) {
    return { snapshot: { currency: data.currency, goals: [], unavailable: "No goals yet", sourceCoverage: data.sourceCoverage }, stateParams: {} };
  }
  return { snapshot: { currency: goals[0].currency, goals, sourceCoverage: data.sourceCoverage, coverage: { goals: evidenceCoverage(data.goals.length, "goals") } }, stateParams: {} };
}
