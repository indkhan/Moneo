// E02-S04 bounded synthetic live gate (manual, never CI): at most TWO real
// OpenRouter requests against synthetic mapping content, plus one zero-spend
// policy-revocation probe. Run with the ignored local .env via Node's native
// mechanism so the key never appears in prompts, logs or output:
//
//   node --env-file=.env ./node_modules/vitest/vitest.mjs run test/mapping-live.test.ts
//
// Report only pass/fail, request counts and non-sensitive metadata (model,
// ceilings, error categories). Skipped without OPENROUTER_API_KEY — a skip
// is not a pass.

import { describe, expect, it } from "vitest";
import {
  classifyMappingError,
  liveMappingTransport,
  loadMappingProvider,
  parseModelBody,
  validateModelMapping,
} from "../apps/web/src/mapping-provider.ts";

const SAMPLE = {
  header: ["date", "description", "amount", "currency"],
  rows: [
    { date: "2026-01-02", description: "Coffee", amount: "-3.50", currency: "EUR" },
    { date: "2026-01-03", description: "Wage", amount: "2000.00", currency: "EUR" },
  ],
};

function prompt(): { system: string; user: string } {
  return {
    system: "You map bank-statement columns to a strict import profile. Reply with JSON only.",
    user: JSON.stringify(SAMPLE),
  };
}

describe("e02-s04 synthetic live gate", () => {
  it("live model proposes a valid mapping for synthetic columns", async () => {
    const config = loadMappingProvider();
    if (!config) {
      console.log("mapping-live: skipped (MAPPING_AI_ENABLED=1 + OPENROUTER_API_KEY required)");
      return;
    }
    const transport = liveMappingTransport(config);
    const promptText = prompt();
    const attempt = await transport({ model: config.model, system: promptText.system, user: promptText.user, maxOutputTokens: 2000 }, 30_000);
    expect(attempt.httpStatus).toBe(200);
    const validated = validateModelMapping(parseModelBody(attempt.bodyText));
    for (const name of [validated.profile.columns.date, validated.profile.columns.description, validated.profile.columns.amount, validated.profile.columns.currency]) {
      if (name !== undefined) expect(SAMPLE.header).toContain(name);
    }
    console.log(`mapping-live: pass (model=${config.model} ceilings=8000/2000)`);
  }, 60_000);

  it("unknown model id fails closed as unavailable-model without spending", async () => {
    const config = loadMappingProvider();
    if (!config) {
      console.log("mapping-live: skipped (MAPPING_AI_ENABLED=1 + OPENROUTER_API_KEY required)");
      return;
    }
    const transport = liveMappingTransport(config);
    const promptText = prompt();
    const attempt = await transport({ model: "moneo/does-not-exist-zzz", system: promptText.system, user: promptText.user, maxOutputTokens: 200 }, 30_000);
    expect(attempt.httpStatus).not.toBe(200);
    const classified = classifyMappingError(attempt.httpStatus);
    expect(classified.retryable).toBe(false);
    console.log(`mapping-live: pass (category=${classified.category})`);
  }, 60_000);
});
