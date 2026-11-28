import "server-only";
import { MockLanguageModelV3 } from "ai/test";

export function qaModel(modelId: string) {
  const text = "Synthetic QA reply.";
  const finishReason = { unified: "stop", raw: undefined } as const;
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  return new MockLanguageModelV3({
    modelId,
    doGenerate: async () => ({ content: [{ type: "text", text }], finishReason, usage, warnings: [] }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "answer" });
          controller.enqueue({ type: "text-delta", id: "answer", delta: text });
          controller.enqueue({ type: "text-end", id: "answer" });
          controller.enqueue({ type: "finish", finishReason, usage });
          controller.close();
        },
      }),
    }),
  });
}
