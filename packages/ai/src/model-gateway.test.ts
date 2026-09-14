import { describe, expect, it } from "vitest";
import { createOpenRouterGateway } from "./model-gateway.js";

describe("OpenRouter model gateway", () => {
  it("records resolved usage for a provider-independent generate call", async () => {
    const recorded: unknown[] = [];
    const gateway = createOpenRouterGateway({
      apiKey: "test-key",
      record: (call) => {
        recorded.push(call);
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            model: "openai/gpt-4.1-mini",
            provider: "OpenAI",
            choices: [{ message: { content: "Grounded answer" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 11, completion_tokens: 3, total_cost: 0.00002 },
          }),
          { status: 200 },
        ),
    });

    const result = await gateway.generate({
      model: "openai/gpt-4.1-mini",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.text).toBe("Grounded answer");
    expect(recorded).toEqual([
      expect.objectContaining({
        requestedModel: "openai/gpt-4.1-mini",
        resolvedProvider: "OpenAI",
        inputTokens: 11,
        outputTokens: 3,
        costMicros: 20,
        finishReason: "stop",
      }),
    ]);
  });

  it("rejects a structured response that does not satisfy its validator", async () => {
    const gateway = createOpenRouterGateway({
      apiKey: "test-key",
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"amount":"oops"}' }, finish_reason: "stop" }],
          }),
          { status: 200 },
        ),
    });
    await expect(
      gateway.generateStructured({
        model: "openai/gpt-4.1-mini",
        messages: [],
        validate: (value) =>
          typeof value === "object" &&
          value !== null &&
          typeof (value as { amount?: unknown }).amount === "number"
            ? (value as { amount: number })
            : null,
      }),
    ).rejects.toThrow("validation");
  });
});
