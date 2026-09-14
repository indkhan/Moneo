export interface ModelToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ModelToolCall[];
  tool_call_id?: string;
}
export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
  tools?: unknown[];
  toolChoice?: "auto" | "required" | "none";
}
export interface ModelResult {
  text: string;
  finishReason: string | null;
  toolCalls?: ModelToolCall[];
}
export interface ModelCallRecord {
  requestedModel: string;
  resolvedModel: string | null;
  resolvedProvider: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costMicros: number | null;
  latencyMs: number;
  finishReason: string | null;
}
export interface ModelGateway {
  generate(request: ModelRequest): Promise<ModelResult>;
  stream(request: ModelRequest): AsyncIterable<string>;
  generateStructured<T>(request: ModelRequest & { validate(value: unknown): T | null }): Promise<T>;
}
type ProviderBody = {
  error?: unknown;
  model?: string;
  provider?: string;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: ModelToolCall[] };
    delta?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    cost?: number;
    total_cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
};
const finite = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);

/** Fixed endpoint, no training providers, and a zero-price ceiling. No paid fallback. */
export function createOpenRouterGateway(options: {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  record?: (call: ModelCallRecord) => void | Promise<void>;
}): ModelGateway {
  async function request(input: ModelRequest, stream: boolean) {
    const response = await (options.fetch ?? globalThis.fetch)(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        signal: input.signal ?? AbortSignal.timeout(60_000),
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          "X-OpenRouter-Title": "Moneo",
        },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          max_tokens: input.maxOutputTokens ?? 2000,
          tools: input.tools,
          tool_choice: input.toolChoice,
          stream,
          ...(stream ? { stream_options: { include_usage: true } } : {}),
          provider: { data_collection: "deny", max_price: { prompt: 0, completion: 0 } },
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        response.status === 429
          ? "Free model rate limit reached. Please try again later."
          : `OpenRouter request failed (${response.status}). Check AI settings or try again.`,
      );
    return response;
  }
  async function record(input: ModelRequest, body: ProviderBody, started: number) {
    const usage = body.usage,
      cost = finite(usage?.cost ?? usage?.total_cost);
    await options.record?.({
      requestedModel: input.model,
      resolvedModel: body.model ?? null,
      resolvedProvider: body.provider ?? null,
      inputTokens: finite(usage?.prompt_tokens),
      outputTokens: finite(usage?.completion_tokens),
      cachedTokens: finite(usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens),
      costMicros: cost === null ? null : Math.round(cost * 1_000_000),
      latencyMs: Date.now() - started,
      finishReason: body.choices?.[0]?.finish_reason ?? null,
    });
  }
  async function generate(input: ModelRequest): Promise<ModelResult> {
    const started = Date.now();
    const response = await request(input, false);
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 200_000) throw new Error("Model response exceeds limit");
    const body = JSON.parse(raw) as ProviderBody;
    if (body.error) throw new Error("OpenRouter could not complete this request. Please retry.");
    const choice = body.choices?.[0],
      calls = choice?.message?.tool_calls;
    const text = choice?.message?.content;
    if (typeof text !== "string" && !calls?.length)
      throw new Error("OpenRouter response has no text content");
    if (
      calls &&
      (!Array.isArray(calls) ||
        (
          calls as Array<{
            id?: unknown;
            type?: unknown;
            function?: { name?: unknown; arguments?: unknown };
          }>
        ).some(
          (c) =>
            typeof c.id !== "string" ||
            c.type !== "function" ||
            typeof c.function?.name !== "string" ||
            typeof c.function.arguments !== "string",
        ))
    )
      throw new Error("Invalid model tool calls");
    await record(input, body, started);
    return {
      text: text ?? "",
      finishReason: choice?.finish_reason ?? null,
      ...(calls ? { toolCalls: calls } : {}),
    };
  }
  return {
    generate,
    async *stream(input) {
      const started = Date.now(),
        response = await request(input, true);
      if (!response.body) throw new Error("OpenRouter returned no stream");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let pending = "",
        bytes = 0,
        complete = false;
      let metadata: ProviderBody = {};
      try {
        while (!complete) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 200_000) throw new Error("Model response exceeds limit");
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              complete = true;
              break;
            }
            const body = JSON.parse(data) as ProviderBody;
            if (body.error) throw new Error("OpenRouter stream failed. Please retry.");
            metadata = {
              ...metadata,
              ...body,
              choices: body.choices?.length ? body.choices : metadata.choices,
            };
            const delta = body.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          }
        }
        if (!complete) throw new Error("OpenRouter stream interrupted. Please retry.");
        await record(input, metadata, started);
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    },
    async generateStructured<T>(
      input: ModelRequest & { validate(value: unknown): T | null },
    ): Promise<T> {
      const response = await generate(input);
      let value: unknown;
      try {
        value = JSON.parse(response.text);
      } catch {
        throw new Error("Structured response is not valid JSON");
      }
      const parsed = input.validate(value);
      if (parsed === null) throw new Error("Structured response failed validation");
      return parsed;
    },
  };
}
