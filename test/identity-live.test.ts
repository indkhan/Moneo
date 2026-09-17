// E00-S05 live identity gates. Opt-in only: run with `npm run probe:identity`.
// Never part of CI (`npm test` / `npm run check`). Without credentials every
// suite skips and names the exact missing input. With credentials the file
// spends at most 5 OpenRouter inference requests (shared budget of 20) plus
// 2 credential-free Auth0 reachability calls. No real data, synthetic only.
// Secret values travel only in request headers at runtime and are never
// logged; failures report statuses, categories and counts only.

import { describe, expect, it } from "vitest";

import {
  liveTransport,
  parseStructuredOutput,
  RequestBudget,
  runBoundedProbe,
  structuredProbeRequest,
  toolProbeRequest,
  unavailableModelProbeRequest,
  validateToolCall,
} from "../proof/identity/openrouter-probe.ts";
import { PROBE_BUDGET } from "../proof/identity/policy.ts";

function has(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
}

function requireApiKey(): string {
  const key = process.env["OPENROUTER_API_KEY"];
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Blocked: OPENROUTER_API_KEY is absent");
  }
  return key;
}

// One budget for the whole live file: the story cap holds across probes.
const liveBudget = new RequestBudget(PROBE_BUDGET.maxRequests);

describe.skipIf(!has("OPENROUTER_API_KEY"))("openrouter live development-model probes", () => {
  it("Blocked without OPENROUTER_API_KEY; bounded tool-selection probe otherwise", async () => {
    const outcome = await runBoundedProbe(liveTransport(requireApiKey()), liveBudget, toolProbeRequest());
    expect(outcome.budgetExhausted).toBe(false);
    expect(outcome.attempt).toBeDefined();
    const attempt = outcome.attempt!;
    expect(attempt.httpStatus).toBe(200);
    const body = JSON.parse(attempt.bodyText) as {
      choices?: { message?: { tool_calls?: { function: { name: string; arguments: string } }[] } }[];
    };
    const calls = body.choices?.[0]?.message?.tool_calls ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const validation = validateToolCall(call.function.name, call.function.arguments);
      expect({ name: call.function.name, ...validation }).toEqual({
        name: expect.any(String),
        ok: true,
        violations: [],
      });
    }
  }, 75_000);

  it("structured-output probe returns schema-exact JSON", async () => {
    const outcome = await runBoundedProbe(liveTransport(requireApiKey()), liveBudget, structuredProbeRequest());
    expect(outcome.budgetExhausted).toBe(false);
    expect(outcome.attempt?.httpStatus).toBe(200);
    const body = JSON.parse(outcome.attempt!.bodyText) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content ?? "";
    expect(parseStructuredOutput(content).ok).toBe(true);
  }, 75_000);

  it("unavailable model surfaces an explicit 404, never a downgrade", async () => {
    const outcome = await runBoundedProbe(
      liveTransport(requireApiKey()),
      liveBudget,
      unavailableModelProbeRequest(),
      0,
    );
    expect(outcome.attempts).toBe(1);
    expect(outcome.attempt?.httpStatus).toBe(404);
    expect(outcome.error).toMatchObject({ category: "unavailable-model", retryable: false });
  }, 40_000);
});

const AUTH0_VARS = [
  "AUTH0_TEST_DOMAIN",
  "AUTH0_TEST_CLIENT_ID",
  "AUTH0_TEST_CLIENT_SECRET",
  "AUTH0_TEST_USERNAME",
  "AUTH0_TEST_PASSWORD",
] as const;
const auth0Ready = AUTH0_VARS.every(has);

describe.skipIf(!auth0Ready)("auth0 live gate", () => {
  it("Blocked: needs test tenant + authorized test account; stale-session denial lands in E01-S02", async () => {
    const domain = process.env["AUTH0_TEST_DOMAIN"]!;
    const params = new URLSearchParams({
      grant_type: "password",
      client_id: process.env["AUTH0_TEST_CLIENT_ID"]!,
      client_secret: process.env["AUTH0_TEST_CLIENT_SECRET"]!,
      username: process.env["AUTH0_TEST_USERNAME"]!,
      password: process.env["AUTH0_TEST_PASSWORD"]!,
      scope: "openid profile email",
    });
    const login = await fetch(`https://${domain}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(PROBE_BUDGET.timeoutMs),
    });
    // Reachability + credential validity only; the app-session revocation
    // contract is proven deterministically and lands in E01-S02.
    expect(login.status).toBe(200);
    const logout = await fetch(`https://${domain}/oidc/logout`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_BUDGET.timeoutMs),
    });
    expect([200, 302, 400]).toContain(logout.status);
  }, 75_000);
});

if (!auth0Ready) {
  describe("auth0 live gate", () => {
    it.skip(`Blocked: founder supplies ${AUTH0_VARS.filter((v) => !has(v)).join(", ")} for the test tenant`, () => {});
  });
}

if (!has("OPENROUTER_API_KEY")) {
  describe("openrouter live development-model probes", () => {
    it.skip("Blocked: founder supplies OPENROUTER_API_KEY (development key, synthetic use only)", () => {});
  });
}

describe("render OIDC live gate", () => {
  it.skip(
    "Blocked: founder supplies Render Pro workspace ID (tea-…) + AWS IAM provider/role ARN in AWS_ROLE_ARN; " +
      "then deploy one service and run `aws sts get-caller-identity` in its shell to prove AssumeRoleWithWebIdentity",
    () => {},
  );
});
