export interface ModelMessage { role: "system" | "user" | "assistant" | "tool"; content: string }
export interface ModelRequest { model: string; messages: ModelMessage[]; maxOutputTokens?: number }
export interface ModelResult { text: string; finishReason: string | null }
export interface ModelCallRecord {
  requestedModel: string; resolvedModel: string | null; resolvedProvider: string | null;
  inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null;
  costMicros: number | null; latencyMs: number; finishReason: string | null;
}
export interface ModelGateway {
  generate(request: ModelRequest): Promise<ModelResult>;
  stream(request: ModelRequest): AsyncIterable<string>;
  generateStructured<T>(request: ModelRequest & { validate(value: unknown): T | null }): Promise<T>;
}

type OpenRouterResponse = {
  model?: unknown; provider?: unknown; choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cached_tokens?: unknown; total_cost?: unknown };
};
const numberOrNull = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const stringOrNull = (value: unknown) => typeof value === "string" ? value : null;

/** OpenRouter adapter; its fixed endpoint prevents custom-provider SSRF. */
export function createOpenRouterGateway(options: {
  apiKey: string; fetch?: typeof globalThis.fetch; record?: (call: ModelCallRecord) => void | Promise<void>;
}): ModelGateway {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  async function generate(request: ModelRequest): Promise<ModelResult> {
    const started = Date.now();
    const response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: request.model, messages: request.messages, max_tokens: request.maxOutputTokens }),
    });
    if (!response.ok) throw new Error(`OpenRouter request failed (${response.status})`);
    const body = await response.json() as OpenRouterResponse;
    const choice = body.choices?.[0];
    const text = stringOrNull(choice?.message?.content);
    if (text === null) throw new Error("OpenRouter response has no text content");
    const usage = body.usage;
    await options.record?.({
      requestedModel: request.model, resolvedModel: stringOrNull(body.model), resolvedProvider: stringOrNull(body.provider),
      inputTokens: numberOrNull(usage?.prompt_tokens), outputTokens: numberOrNull(usage?.completion_tokens), cachedTokens: numberOrNull(usage?.cached_tokens),
      costMicros: numberOrNull(usage?.total_cost) === null ? null : Math.round((usage!.total_cost as number) * 1_000_000),
      latencyMs: Date.now() - started, finishReason: stringOrNull(choice?.finish_reason),
    });
    return { text, finishReason: stringOrNull(choice?.finish_reason) };
  }
  return {
    generate,
    async *stream(request) { yield (await generate(request)).text; },
    async generateStructured<T>(request: ModelRequest & { validate(value: unknown): T | null }): Promise<T> {
      let value: unknown;
      try { value = JSON.parse((await generate(request)).text); } catch { throw new Error("Structured response is not valid JSON"); }
      const parsed = request.validate(value);
      if (parsed === null) throw new Error("Structured response failed validation");
      return parsed;
    },
  };
}
