// E04-S06 AI settings and usage: read-only aggregates for the settings page.
// Reuses ai_policies, ai_exclusions, ai_dispatch_budgets, ai_dispatch_reservations,
// ai_dispatch_usage from E04-S01/E01-S05. No new tables; exposes a view.

import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "./ids.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "./tenancy.ts";
import { formatDecimalBigint, parseDecimalBigint } from "./money.ts";
import { getPolicy, setAccountExclusion, summarizeEligible } from "./ai-policy.ts";
import { setDispatchBudget } from "./ai-dispatch.ts";
import { loadProductionRouteConfig } from "./ai-dispatch.ts";

export class SettingsError extends Error {
  readonly code: "not_found" | "invalid_input" | "version_mismatch";
  constructor(code: SettingsError["code"]) {
    super(code);
    this.code = code;
  }
}

export type BudgetView = {
  moneyBudgetMinor: string;
  tokenBudget: number;
  concurrencyLimit: number;
};

export type UsageAggregate = {
  reservedMoneyMinor: string;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  reconciledMoneyMinor: string;
  reconciledInputTokens: number;
  reconciledOutputTokens: number;
  pendingMoneyMinor: string;
  pendingInputTokens: number;
  pendingOutputTokens: number;
  pendingCount: number;
  reconciledCount: number;
  releasedCount: number;
};

export type SettingsView = {
  budget: BudgetView;
  usage: UsageAggregate;
  policyVersion: string;
  exclusionCount: number;
  eligibleAccountCount: number;
  coverage: "full" | "partial";
  routeClass: "development" | "production";
};

/** Read aggregated usage stats for the settings page (from ai_settings_usage view). */
export async function getUsageAggregate(
  pool: Pool,
  claims: TenantClaims,
): Promise<UsageAggregate> {
  return withTenant(pool, claims, async (client) => {
    const row = await client.query(
      `SELECT
        COALESCE(reserved_money_minor, '0') AS reserved_money_minor,
        COALESCE(reserved_input_tokens, 0) AS reserved_input_tokens,
        COALESCE(reserved_output_tokens, 0) AS reserved_output_tokens,
        COALESCE(reconciled_money_minor, '0') AS reconciled_money_minor,
        COALESCE(reconciled_input_tokens, 0) AS reconciled_input_tokens,
        COALESCE(reconciled_output_tokens, 0) AS reconciled_output_tokens,
        COALESCE(pending_money_minor, '0') AS pending_money_minor,
        COALESCE(pending_input_tokens, 0) AS pending_input_tokens,
        COALESCE(pending_output_tokens, 0) AS pending_output_tokens,
        COALESCE(pending_count, 0) AS pending_count,
        COALESCE(reconciled_count, 0) AS reconciled_count,
        COALESCE(released_count, 0) AS released_count
       FROM ai_settings_usage WHERE workspace_id = $1`,
      [claims.workspaceId],
    );
    if ((row.rowCount ?? 0) === 0) {
      return {
        reservedMoneyMinor: "0",
        reservedInputTokens: 0,
        reservedOutputTokens: 0,
        reconciledMoneyMinor: "0",
        reconciledInputTokens: 0,
        reconciledOutputTokens: 0,
        pendingMoneyMinor: "0",
        pendingInputTokens: 0,
        pendingOutputTokens: 0,
        pendingCount: 0,
        reconciledCount: 0,
        releasedCount: 0,
      };
    }
    const r = row.rows[0] as {
      reserved_money_minor: string;
      reserved_input_tokens: number;
      reserved_output_tokens: number;
      reconciled_money_minor: string;
      reconciled_input_tokens: number;
      reconciled_output_tokens: number;
      pending_money_minor: string;
      pending_input_tokens: number;
      pending_output_tokens: number;
      pending_count: number;
      reconciled_count: number;
      released_count: number;
    };
    return {
      reservedMoneyMinor: r.reserved_money_minor,
      reservedInputTokens: r.reserved_input_tokens,
      reservedOutputTokens: r.reserved_output_tokens,
      reconciledMoneyMinor: r.reconciled_money_minor,
      reconciledInputTokens: r.reconciled_input_tokens,
      reconciledOutputTokens: r.reconciled_output_tokens,
      pendingMoneyMinor: r.pending_money_minor,
      pendingInputTokens: r.pending_input_tokens,
      pendingOutputTokens: r.pending_output_tokens,
      pendingCount: r.pending_count,
      reconciledCount: r.reconciled_count,
      releasedCount: r.released_count,
    };
  });
}

/** Full settings view for the settings page. */
export async function getSettingsView(
  pool: Pool,
  claims: TenantClaims,
): Promise<SettingsView> {
  const [budget, usage, policy, eligible] = await Promise.all([
    withTenant(pool, claims, async (client) => {
      const row = await client.query(
        "SELECT money_budget_minor, token_budget, concurrency_limit FROM ai_dispatch_budgets WHERE workspace_id = $1",
        [claims.workspaceId],
      );
      if ((row.rowCount ?? 0) === 0) {
        return { moneyBudgetMinor: "1000", tokenBudget: 40000, concurrencyLimit: 5 };
      }
      const r = row.rows[0] as { money_budget_minor: string; token_budget: number; concurrency_limit: number };
      return { moneyBudgetMinor: r.money_budget_minor, tokenBudget: r.token_budget, concurrencyLimit: r.concurrency_limit };
    }),
    getUsageAggregate(pool, claims),
    getPolicy(pool, claims),
    summarizeEligible(pool, claims),
  ]);

  // S03-L: the badge reflects the full production capability, never the
  // qualification flag alone.
  let routeClass: "development" | "production" = "development";
  try {
    loadProductionRouteConfig();
    routeClass = "production";
  } catch {
    routeClass = "development";
  }

  return {
    budget,
    usage,
    policyVersion: policy.policyVersion,
    exclusionCount: policy.excludedAccountIds.length,
    eligibleAccountCount: eligible.accountCount,
    coverage: eligible.coverage,
    routeClass,
  };
}

/** Update dispatch budgets (called from settings form). */
export async function updateDispatchBudget(
  pool: Pool,
  claims: TenantClaims,
  input: { moneyMinor: string; tokens: number; concurrency: number },
): Promise<BudgetView> {
  return setDispatchBudget(pool, claims, input);
}

/** Toggle account AI exclusion (reuses E01-S05 logic). */
export async function toggleAccountExclusion(
  pool: Pool,
  claims: TenantClaims,
  actorId: string,
  accountId: string,
  excluded: boolean,
): Promise<{ policyVersion: string; excludedAccountIds: string[] }> {
  return setAccountExclusion(pool, claims, actorId, accountId, excluded);
}

/** Route class for the settings page: full production capability or development. */
export function getRouteClass(): "development" | "production" {
  try {
    loadProductionRouteConfig();
    return "production";
  } catch {
    return "development";
  }
}

export function settingsErrorBody(err: SettingsError): { status: number; body: unknown } {
  switch (err.code) {
    case "not_found":
      return { status: 404, body: { error: "not_found" } };
    case "invalid_input":
      return { status: 400, body: { error: "invalid_input" } };
    case "version_mismatch":
      return { status: 409, body: { error: "version_mismatch" } };
  }
}