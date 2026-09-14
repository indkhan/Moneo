import { expect, it } from "vitest";
import { createOpenRouterGateway } from "./model-gateway.js";

it("streams real provider deltas, requests private free-only routing, and records current usage fields", async () => {
  let sent: Record<string, unknown> = {};
  const calls: unknown[] = [];
  const gateway = createOpenRouterGateway({
    apiKey: "synthetic",
    record: (c) => {
      calls.push(c);
    },
    fetch: async (_url, init) => {
      sent = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
      return new Response(
        'data: {"model":"test/free","choices":[{"delta":{"content":"Hello "}}]}\n\ndata: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"cost":0,"prompt_tokens_details":{"cached_tokens":1}}}\n\ndata: [DONE]\n\n',
      );
    },
  });
  const chunks: string[] = [];
  for await (const chunk of gateway.stream({ model: "openrouter/free", messages: [] }))
    chunks.push(chunk);
  expect(chunks).toEqual(["Hello ", "world"]);
  expect(sent).toMatchObject({
    stream: true,
    provider: { data_collection: "deny", max_price: { prompt: 0, completion: 0 } },
  });
  expect(calls).toEqual([expect.objectContaining({ costMicros: 0, cachedTokens: 1 })]);
});

it("keeps native tool calls when the provider returns null content", async () => {
  const toolCalls = [
    { id: "call_1", type: "function", function: { name: "cashflow", arguments: "{}" } },
  ];
  const gateway = createOpenRouterGateway({
    apiKey: "synthetic",
    fetch: async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: null, tool_calls: toolCalls }, finish_reason: "tool_calls" },
          ],
        }),
      ),
  });
  expect(await gateway.generate({ model: "openrouter/free", messages: [] })).toMatchObject({
    text: "",
    toolCalls,
  });
});
