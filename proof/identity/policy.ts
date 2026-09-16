// E00-S05 identity proof: separate development vs production provider policy.
//
// Pure decision logic for architecture §130. No network, no secrets, no
// production code paths. Deterministic tests live in test/identity.test.ts.

export type Environment = "development" | "production";

// A deployment profile as configured, never inferred from a model name alone.
export interface RouteProfile {
  // Whether this route may train on prompts (free/training-permitted routes).
  trainingPermitted: boolean;
  // Whether Zero Data Retention routing is enforced for the request.
  zdrEnforced: boolean;
  // Whether content logging / third-party response caching is enabled.
  contentLoggingEnabled: boolean;
  // Whether the endpoint is a free-tier variant (:free).
  freeTier: boolean;
  // Whether this exact free endpoint was independently qualified for
  // production (policy + quality + capacity). Absent means unqualified.
  productionQualified: boolean;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

// Returns allowed=false with an explicit reason instead of weakening policy.
export function resolveProviderPolicy(env: Environment, route: RouteProfile): PolicyDecision {
  if (env === "production") {
    if (route.trainingPermitted) {
      return {
        allowed: false,
        reason: "production denies training-permitted routes (§130)",
      };
    }
    if (!route.zdrEnforced) {
      return {
        allowed: false,
        reason: "production requires zdr:true on every request (§130)",
      };
    }
    if (route.contentLoggingEnabled) {
      return {
        allowed: false,
        reason: "production disables content logging for financial traffic (§131)",
      };
    }
    if (route.freeTier && !route.productionQualified) {
      return {
        allowed: false,
        reason:
          "unqualified free-tier route is development-only; " +
          "a free model needs independent policy/quality/capacity qualification (§130)",
      };
    }
    return { allowed: true, reason: "production no-training/ZDR route" };
  }
  // Development (founder-authorized): free/training-permitted routes allowed
  // with synthetic fixtures by default. Still no secrets in context.
  return { allowed: true, reason: "development training-permitted route (§130)" };
}

export type DispatchOutcome =
  | { kind: "dispatched"; via: "primary" | "fallback" }
  | { kind: "unavailable"; reason: string };

// A failing primary never silently downgrades: the fallback must independently
// satisfy the environment policy, otherwise the call fails recoverable.
export function selectRoute(
  env: Environment,
  primary: RouteProfile,
  fallback: RouteProfile | null,
): DispatchOutcome {
  if (resolveProviderPolicy(env, primary).allowed) {
    return { kind: "dispatched", via: "primary" };
  }
  if (fallback !== null && resolveProviderPolicy(env, fallback).allowed) {
    return { kind: "dispatched", via: "fallback" };
  }
  return {
    kind: "unavailable",
    reason: "no qualified route; refusing privacy downgrade fallback (§130)",
  };
}

// Shared live-probe budget for the whole story: at most 20 synthetic live
// requests, 30 s timeout each, at most one bounded retry per probe.
export const PROBE_BUDGET = {
  maxRequests: 20,
  timeoutMs: 30_000,
  maxRetriesPerProbe: 1,
  maxOutputTokens: 256,
} as const;
