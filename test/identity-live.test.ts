// E00-S05 live identity gates. Opt-in only: run with `npm run probe:identity`.
// Never part of CI (`npm test` / `npm run check`). Without credentials every
// suite skips and names the exact missing input. With credentials the file
// spends at most 5 OpenRouter inference requests (shared budget of 20).
// No real data, synthetic only.
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

  it("unavailable model is rejected explicitly, never downgraded or retried", async () => {
    const outcome = await runBoundedProbe(
      liveTransport(requireApiKey()),
      liveBudget,
      unavailableModelProbeRequest(),
      0,
    );
    expect(outcome.attempts).toBe(1);
    expect([400, 404]).toContain(outcome.attempt?.httpStatus);
    expect(outcome.error).toMatchObject({
      category: outcome.attempt?.httpStatus === 404 ? "unavailable-model" : "invalid-request",
      retryable: false,
    });
  }, 40_000);
});

if (!has("OPENROUTER_API_KEY")) {
  describe("openrouter live development-model probes", () => {
    it.skip("Blocked: founder supplies OPENROUTER_API_KEY (development key, synthetic use only)", () => {});
  });
}
