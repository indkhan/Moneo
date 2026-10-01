// Host-built snapshots for the generated calculator sandbox.
// Finance data comes ONLY from existing host-approved SDK operations
// (lib/artifacts/finance-sdk.ts + lib/finance/tools.ts). Generated code
// never queries the database; it receives one of these small JSON
// snapshots as input.snapshot plus artifact-local params.

import { goalsForArtifact, spendingForArtifact, tripForArtifact } from "./finance-sdk";
import { dailySpending } from "@/lib/finance/calculations";
import type { ArtifactKind } from "./spec";

export type CalculatorSnapshot =
  | {
      currency: string;
      incomeMinor?: string;
      spendingMinor?: string;
      netMinor?: string;
      daily?: { date: string; spendingMinor: string }[];
      unavailable?: string;
    }
  | {
      currency: string;
      baselineAvailableMinor?: string | null;
      unavailable?: string | null;
      tripDate?: string;
    }
  | {
      currency: string;
      goals?: { id: string; name: string; currency: string; targetMinor: string; savedMinor: string; remainingMinor: string }[];
      unavailable?: string;
    };

export async function buildCalculatorSnapshot(
  artifactId: string,
  kind: ArtifactKind,
  opts?: { query?: string; costMinor?: bigint },
): Promise<{ snapshot: CalculatorSnapshot; stateParams: Record<string, number | string> }> {
  if (kind === "spending_explorer") {
    const data = await spendingForArtifact(artifactId, opts?.query ?? "");
    if ("unavailable" in data.summary) {
      return {
        snapshot: { currency: data.currency, unavailable: data.summary.unavailable },
        stateParams: {},
      };
    }
    return {
      snapshot: {
        currency: data.currency,
        incomeMinor: data.summary.incomeMinor,
        spendingMinor: data.summary.spendingMinor,
        netMinor: data.summary.netMinor,
        daily: dailySpending(data.transactions.map(row => ({ date: row.posted_on, amountMinor: BigInt(row.amount_minor), kind: row.kind })), data.from, data.to),
      },
      stateParams: {},
    };
  }
  if (kind === "trip_planner") {
    const data = await tripForArtifact(artifactId, opts?.costMinor ?? 90000n);
    return {
      snapshot: {
        currency: data.currency,
        baselineAvailableMinor:
          data.baseline.status === "available" ? data.baseline.amountMinor.toString() : null,
        unavailable: data.unavailable ?? (data.baseline.status === "available" ? null : "Forecast unavailable"),
        tripDate: data.tripDate,
      },
      stateParams: { costMinor: Number(opts?.costMinor ?? 90000n) },
    };
  }
  const data = await goalsForArtifact(artifactId);
  const balances = new Map(data.balances.map((b) => [b.id, b.currency_code]));
  const currencies = new Set(data.goals.map(goal => goal.currency_code));
  if (currencies.size > 1) {
    return { snapshot: { currency: data.currency, goals: [], unavailable: "Goals use different currencies; choose a single currency before comparing saving pace" }, stateParams: {} };
  }
  if (data.goals.some(goal => data.allocations.some(allocation => allocation.goal_id === goal.id && balances.get(allocation.account_id) !== goal.currency_code))) {
    return { snapshot: { currency: data.currency, goals: [], unavailable: "Goal allocations require currency conversion" }, stateParams: {} };
  }
  const goals = (data.goals ?? []).slice(0, 20).map((g) => {
    const allocs = (data.allocations ?? []).filter((a) => a.goal_id === g.id);
    const saved = allocs.reduce((s, a) => s + BigInt(a.amount_minor), 0n);
    const target = BigInt(g.target_minor);
    return {
      id: g.id,
      name: g.name,
      currency: g.currency_code,
      targetMinor: target.toString(),
      savedMinor: saved.toString(),
      remainingMinor: (target > saved ? target - saved : 0n).toString(),
    };
  });
  if (!goals.length) {
    return { snapshot: { currency: data.currency, goals: [], unavailable: "No goals yet" }, stateParams: {} };
  }
  return { snapshot: { currency: goals[0].currency, goals }, stateParams: {} };
}
