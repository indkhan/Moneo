// E00-S05 deterministic identity proof tests.
//
// No network, no secrets, no environment dependency: every provider behavior
// that cannot reliably be triggered live (429/5xx/timeout, malformed output
// on demand) is covered here through mock transports. Live gates live in
// test/identity-live.test.ts and stay skipped without credentials.

import { describe, expect, it } from "vitest";

import {
  BOGUS_MODEL_ID,
  classifyProviderError,
  liveTransport,
  parseStructuredOutput,
  RequestBudget,
  runBoundedProbe,
  SELECTED_DEV_MODEL,
  structuredProbeRequest,
  SYNTHETIC_TOOL_NAME,
  toolProbeRequest,
  unavailableModelProbeRequest,
  validateToolCall,
  type ProbeAttempt,
  type ProbeTransport,
} from "../proof/identity/openrouter-probe.ts";
import { PROBE_BUDGET, resolveProviderPolicy, selectRoute, type RouteProfile } from "../proof/identity/policy.ts";
import { checkRenderOidcReadiness, allowStaticAwsKeys } from "../proof/identity/render-oidc.ts";
import {
  applyAppRevocation,
  applySsoLogout,
  evaluateRequest,
  FRESH_SESSION,
} from "../proof/identity/session-layers.ts";

const DEV_FREE_ROUTE: RouteProfile = {
  trainingPermitted: true,
  zdrEnforced: false,
  contentLoggingEnabled: false,
  freeTier: true,
  productionQualified: false,
};

const PROD_ROUTE: RouteProfile = {
  trainingPermitted: false,
  zdrEnforced: true,
  contentLoggingEnabled: false,
  freeTier: false,
  productionQualified: false,
};

describe("dev vs production provider policy (§130)", () => {
  it("allows the training-permitted free route in development", () => {
    expect(resolveProviderPolicy("development", DEV_FREE_ROUTE).allowed).toBe(true);
  });

  it("denies training-permitted routes in production", () => {
    const decision = resolveProviderPolicy("production", DEV_FREE_ROUTE);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/training-permitted/);
  });

  it("denies production routes without ZDR enforcement", () => {
    const decision = resolveProviderPolicy("production", { ...PROD_ROUTE, zdrEnforced: false });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/zdr/);
  });

  it("denies production routes with content logging enabled", () => {
    const decision = resolveProviderPolicy("production", { ...PROD_ROUTE, contentLoggingEnabled: true });
    expect(decision.allowed).toBe(false);
  });

  it("denies unqualified free-tier routes in production", () => {
    const route: RouteProfile = {
      trainingPermitted: false,
      zdrEnforced: true,
      contentLoggingEnabled: false,
      freeTier: true,
      productionQualified: false,
    };
    expect(resolveProviderPolicy("production", route).allowed).toBe(false);
  });

  it("allows a compliant production route", () => {
    expect(resolveProviderPolicy("production", PROD_ROUTE)).toEqual({
      allowed: true,
      reason: expect.any(String),
    });
  });

  it("never silently downgrades to a non-compliant fallback", () => {
    const outcome = selectRoute("production", { ...PROD_ROUTE, zdrEnforced: false }, DEV_FREE_ROUTE);
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: expect.stringMatching(/refusing privacy downgrade/),
    });
  });

  it("uses a compliant fallback when the primary fails closed", () => {
    const outcome = selectRoute("production", { ...PROD_ROUTE, zdrEnforced: false }, PROD_ROUTE);
    expect(outcome).toEqual({ kind: "dispatched", via: "fallback" });
  });

  it("pins the live-probe budget: 20 requests, 30 s, one retry", () => {
    expect(PROBE_BUDGET.maxRequests).toBe(20);
    expect(PROBE_BUDGET.timeoutMs).toBe(30_000);
    expect(PROBE_BUDGET.maxRetriesPerProbe).toBe(1);
  });
});

describe("application session vs provider SSO logout (§426)", () => {
  it("allows a fresh session", () => {
    expect(evaluateRequest(FRESH_SESSION)).toBe("allow");
  });

  it("denies a copied old cookie after application revocation, even with live SSO", () => {
    const revoked = applyAppRevocation(FRESH_SESSION);
    expect(revoked.ssoSessionAlive).toBe(true);
    expect(evaluateRequest(revoked)).toBe("deny-stale-session");
  });

  it("SSO logout alone leaves an issued application cookie valid (the E01-S02 revoke-first rule)", () => {
    const afterSsoLogout = applySsoLogout(FRESH_SESSION);
    expect(afterSsoLogout.ssoSessionAlive).toBe(false);
    expect(evaluateRequest(afterSsoLogout)).toBe("allow");
  });

  it("denies when both layers are gone", () => {
    const gone = applyAppRevocation(applySsoLogout(FRESH_SESSION));
    expect(evaluateRequest(gone)).toBe("deny-stale-session");
  });
});

describe("Render OIDC readiness gate (§370)", () => {
  it("blocks a non-Pro workspace and names the founder input", () => {
    const verdict = checkRenderOidcReadiness({
      workspacePlan: "free",
      workspaceIdKnown: false,
      awsIdentityProviderConfigured: false,
      roleArnKnown: false,
      singleRolePerService: true,
    });
    expect(verdict.ready).toBe(false);
    if (!verdict.ready) {
      expect(verdict.blockedBy).toBe("render-managed-oidc-plan");
      expect(verdict.founderInput).toMatch(/Pro plan or higher/);
    }
  });

  it("blocks a missing workspace ID", () => {
    const verdict = checkRenderOidcReadiness({
      workspacePlan: "pro",
      workspaceIdKnown: false,
      awsIdentityProviderConfigured: false,
      roleArnKnown: false,
      singleRolePerService: true,
    });
    expect(verdict.ready).toBe(false);
    if (!verdict.ready) {
      expect(verdict.blockedBy).toBe("render-workspace-id");
    }
  });

  it("blocks a missing AWS identity provider", () => {
    const verdict = checkRenderOidcReadiness({
      workspacePlan: "pro",
      workspaceIdKnown: true,
      awsIdentityProviderConfigured: false,
      roleArnKnown: false,
      singleRolePerService: true,
    });
    expect(verdict.ready).toBe(false);
    if (!verdict.ready) {
      expect(verdict.blockedBy).toBe("aws-iam-identity-provider");
    }
  });

  it("blocks a missing least-privilege role ARN", () => {
    const verdict = checkRenderOidcReadiness({
      workspacePlan: "pro",
      workspaceIdKnown: true,
      awsIdentityProviderConfigured: true,
      roleArnKnown: false,
      singleRolePerService: true,
    });
    expect(verdict.ready).toBe(false);
    if (!verdict.ready) {
      expect(verdict.blockedBy).toBe("aws-role-arn");
      expect(verdict.founderInput).toMatch(/AWS_ROLE_ARN/);
    }
  });

  it("reports ready only with the full least-privilege shape", () => {
    const verdict = checkRenderOidcReadiness({
      workspacePlan: "pro",
      workspaceIdKnown: true,
      awsIdentityProviderConfigured: true,
      roleArnKnown: true,
      singleRolePerService: true,
    });
    expect(verdict).toEqual({ ready: true, note: expect.any(String) });
  });

  it("refuses permanent AWS keys as a fallback", () => {
    expect(allowStaticAwsKeys("test").allowed).toBe(false);
  });
});

describe("synthetic tool selection and argument schema", () => {
  const goodArgs = JSON.stringify({ title: "probe", amountMinor: "1234", currency: "EUR" });

  it("accepts the exact synthetic tool call", () => {
    expect(validateToolCall(SYNTHETIC_TOOL_NAME, goodArgs)).toEqual({ ok: true, violations: [] });
  });

  it("rejects an unexpected tool name (tool selection)", () => {
    const result = validateToolCall("transfer_money", goodArgs);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([expect.stringMatching(/^unexpected-tool:/)]);
  });

  it("rejects non-JSON arguments", () => {
    expect(validateToolCall(SYNTHETIC_TOOL_NAME, "not json").ok).toBe(false);
  });

  it("rejects non-object arguments", () => {
    expect(validateToolCall(SYNTHETIC_TOOL_NAME, "[1,2]").ok).toBe(false);
  });

  it("rejects float money strings instead of guessing", () => {
    const args = JSON.stringify({ title: "probe", amountMinor: "12.34", currency: "EUR" });
    const result = validateToolCall(SYNTHETIC_TOOL_NAME, args);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("amountMinor-must-be-decimal-string");
  });

  it("rejects unknown currencies and unknown fields", () => {
    const args = JSON.stringify({ title: "probe", amountMinor: "5", currency: "USD", sql: "x" });
    const result = validateToolCall(SYNTHETIC_TOOL_NAME, args);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("currency-must-be-known-enum");
    expect(result.violations).toContain("unknown-field:sql");
  });
});

describe("malformed structured-output handling", () => {
  it("accepts exact JSON matching the memo schema", () => {
    expect(parseStructuredOutput('{"title":"probe","amountMinor":"1234","currency":"EUR"}')).toEqual({
      ok: true,
      title: "probe",
      amountMinor: "1234",
      currency: "EUR",
    });
  });

  it("classifies prose as non-JSON instead of writing it anywhere", () => {
    const result = parseStructuredOutput("The memo is 12.34 EUR, roughly.");
    expect(result).toEqual({ ok: false, kind: "non-json", detail: expect.any(String) });
  });

  it("classifies schema violations (missing field, float money)", () => {
    expect(parseStructuredOutput('{"title":"probe","currency":"EUR"}').ok).toBe(false);
    const float = parseStructuredOutput('{"title":"t","amountMinor":"12.34","currency":"EUR"}');
    expect(float).toEqual({ ok: false, kind: "schema-violation", detail: expect.any(String) });
  });
});

describe("provider error classification", () => {
  it("never retries auth/credit/forbidden/unavailable-model", () => {
    expect(classifyProviderError(401)).toMatchObject({ category: "auth", retryable: false });
    expect(classifyProviderError(402)).toMatchObject({ category: "credit", retryable: false });
    expect(classifyProviderError(403)).toMatchObject({ category: "forbidden", retryable: false });
    expect(classifyProviderError(404)).toMatchObject({ category: "unavailable-model", retryable: false });
    expect(classifyProviderError(400)).toMatchObject({ category: "invalid-request", retryable: false });
  });

  it("retries rate limits, timeouts and provider failures with backoff guidance", () => {
    expect(classifyProviderError(429, 1000)).toMatchObject({ category: "rate-limited", retryable: true });
    expect(classifyProviderError(408)).toMatchObject({ category: "timeout", retryable: true });
    expect(classifyProviderError(503)).toMatchObject({ category: "provider-unavailable", retryable: true });
    expect(classifyProviderError(null)).toMatchObject({ category: "transport-error", retryable: true });
  });
});

function scripted(responses: ProbeAttempt[]): ProbeTransport {
  const queue = [...responses];
  return async () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("mock transport exhausted");
    }
    return next;
  };
}

const okAttempt: ProbeAttempt = { httpStatus: 200, bodyText: '{"ok":true}' };

describe("bounded probe budget and retry", () => {
  it("succeeds first try with one budget unit", async () => {
    const budget = new RequestBudget();
    const outcome = await runBoundedProbe(scripted([okAttempt]), budget, toolProbeRequest());
    expect(outcome.attempts).toBe(1);
    expect(outcome.error).toBeUndefined();
    expect(budget.spent).toBe(1);
  });

  it("retries a rate limit once, then reports success", async () => {
    const budget = new RequestBudget();
    const outcome = await runBoundedProbe(
      scripted([
        { httpStatus: 429, bodyText: "rate limited" },
        okAttempt,
      ]),
      budget,
      structuredProbeRequest(),
    );
    expect(outcome.attempts).toBe(2);
    expect(outcome.error).toBeUndefined();
    expect(budget.spent).toBe(2);
  });

  it("surfaces a persistent rate limit instead of retrying forever", async () => {
    const budget = new RequestBudget();
    const outcome = await runBoundedProbe(
      scripted([
        { httpStatus: 429, bodyText: "slow down" },
        { httpStatus: 429, bodyText: "slow down" },
      ]),
      budget,
      structuredProbeRequest(),
    );
    expect(outcome.attempts).toBe(2);
    expect(outcome.error).toMatchObject({ category: "rate-limited" });
  });

  it("does not retry auth failures", async () => {
    const budget = new RequestBudget();
    const outcome = await runBoundedProbe(scripted([{ httpStatus: 401, bodyText: "nope" }]), budget, toolProbeRequest());
    expect(outcome.attempts).toBe(1);
    expect(outcome.error).toMatchObject({ category: "auth" });
  });

  it("does not retry unavailable models", async () => {
    const budget = new RequestBudget();
    const outcome = await runBoundedProbe(
      scripted([{ httpStatus: 404, bodyText: "not found" }]),
      budget,
      unavailableModelProbeRequest(),
    );
    expect(outcome.attempts).toBe(1);
    expect(outcome.error).toMatchObject({ category: "unavailable-model" });
  });

  it("recovers from a transport timeout within the retry budget", async () => {
    const budget = new RequestBudget();
    const outcome = await runBoundedProbe(
      scripted([{ httpStatus: null, bodyText: "", transportError: "TimeoutError" }, okAttempt]),
      budget,
      toolProbeRequest(),
    );
    expect(outcome.attempts).toBe(2);
    expect(outcome.error).toBeUndefined();
  });

  it("enforces the hard request cap instead of exceeding it", async () => {
    const budget = new RequestBudget(1);
    const first = await runBoundedProbe(scripted([okAttempt]), budget, toolProbeRequest());
    expect(first.budgetExhausted).toBe(false);
    const second = await runBoundedProbe(scripted([okAttempt]), budget, toolProbeRequest());
    expect(second.attempts).toBe(0);
    expect(second.attempt).toBeUndefined();
    expect(second.budgetExhausted).toBe(true);
  });

  it("makes a single attempt when retries are disabled", async () => {
    const budget = new RequestBudget();
    const outcome = await runBoundedProbe(
      scripted([
        { httpStatus: 503, bodyText: "down" },
        okAttempt,
      ]),
      budget,
      toolProbeRequest(),
      0,
    );
    expect(outcome.attempts).toBe(1);
    expect(outcome.error).toMatchObject({ category: "provider-unavailable" });
  });
});

describe("probe request builders", () => {
  it("targets the explicitly selected free development model", () => {
    expect(SELECTED_DEV_MODEL.id).toMatch(/:free$/);
    expect(toolProbeRequest().model).toBe(SELECTED_DEV_MODEL.id);
    expect(structuredProbeRequest().model).toBe(SELECTED_DEV_MODEL.id);
  });

  it("bounds output tokens within the story budget", () => {
    expect(toolProbeRequest().maxTokens).toBeLessThanOrEqual(PROBE_BUDGET.maxOutputTokens);
    expect(structuredProbeRequest().maxTokens).toBeLessThanOrEqual(PROBE_BUDGET.maxOutputTokens);
  });

  it("probes unavailability with a bogus model id", () => {
    expect(unavailableModelProbeRequest().model).toBe(BOGUS_MODEL_ID);
  });

  it("constructs a live transport without touching secrets", () => {
    expect(typeof liveTransport("placeholder-never-a-real-key")).toBe("function");
  });
});
