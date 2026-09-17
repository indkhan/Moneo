// E00-S05 identity proof: bounded OpenRouter development-model probe.
//
// Covers tool selection, argument schema, malformed-output handling, and
// unavailable/rate-limited provider behavior. Live transport uses only
// synthetic prompts, a 30 s timeout, at most one bounded retry per probe,
// and a hard 20-request total budget. Anything that cannot reliably be
// triggered live (429/5xx/timeout, malformed output on demand) is covered by
// deterministic mock-transport cases in test/identity.test.ts. No secrets are
// logged; the API key only travels in the Authorization header at runtime.

import { PROBE_BUDGET } from "./policy.ts";

// Explicitly selected development model. Chosen from the live catalog
// (GET https://openrouter.ai/api/v1/models, checked 2026-09-17): 20 `:free`
// variants were listed; this one advertises both `tools`/`tool_choice` and
// `structured_outputs`/`response_format`, which the tool/structured-output
// probes need. Free availability rotates; a failing free model is replaced,
// never accommodated by weakening validation.
export const SELECTED_DEV_MODEL = {
  id: "liquid/lfm-2.5-2.6b:free",
  selectedOn: "2026-09-17",
  contextLength: 65536,
  why: "free variant listed live with tools + structured_outputs support",
  freeTierLimits: "20 req/min; 50 req/day (<10 credits purchased) or 1000 req/day (>=10)",
  trainingDisclosure:
    "development-only training-permitted route; synthetic fixtures only, " +
    "never founder/customer data (§130). Production requires qualified no-training/ZDR routes.",
} as const;

export const BOGUS_MODEL_ID = "moneo/does-not-exist-zzz";

// One synthetic finance-flavored tool. Strict allowlist: exactly this name,
// exactly these fields, exact decimal-string money (no floats, no guessing).
export const SYNTHETIC_TOOL_NAME = "record_memo";
const AMOUNT_MINOR_RE = /^[0-9]+$/;
const CURRENCIES = ["EUR", "JPY", "KWD"] as const;

export interface ToolValidation {
  ok: boolean;
  violations: string[];
}

export function validateToolCall(name: string, argsText: string): ToolValidation {
  const violations: string[] = [];
  if (name !== SYNTHETIC_TOOL_NAME) {
    return { ok: false, violations: [`unexpected-tool:${name}`] };
  }
  let args: unknown;
  try {
    args = JSON.parse(argsText);
  } catch {
    return { ok: false, violations: ["args-not-json"] };
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, violations: ["args-not-object"] };
  }
  const record = args as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "title" && key !== "amountMinor" && key !== "currency") {
      violations.push(`unknown-field:${key}`);
    }
  }
  if (typeof record["title"] !== "string" || record["title"].length === 0) {
    violations.push("title-must-be-nonempty-string");
  }
  if (typeof record["amountMinor"] !== "string" || !AMOUNT_MINOR_RE.test(record["amountMinor"])) {
    violations.push("amountMinor-must-be-decimal-string");
  }
  if (typeof record["currency"] !== "string" || !(CURRENCIES as readonly string[]).includes(record["currency"])) {
    violations.push("currency-must-be-known-enum");
  }
  return { ok: violations.length === 0, violations };
}

export type StructuredResult =
  | { ok: true; title: string; amountMinor: string; currency: string }
  | { ok: false; kind: "non-json" | "schema-violation"; detail: string };

// Malformed model output must be rejected, never written as canonical data.
export function parseStructuredOutput(text: string): StructuredResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, kind: "non-json", detail: "output is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, kind: "schema-violation", detail: "output is not an object" };
  }
  const record = parsed as Record<string, unknown>;
  const title = record["title"];
  const amountMinor = record["amountMinor"];
  const currency = record["currency"];
  if (
    typeof title !== "string" ||
    title.length === 0 ||
    typeof amountMinor !== "string" ||
    !AMOUNT_MINOR_RE.test(amountMinor) ||
    typeof currency !== "string" ||
    !(CURRENCIES as readonly string[]).includes(currency)
  ) {
    return { ok: false, kind: "schema-violation", detail: "fields fail the memo schema" };
  }
  return { ok: true, title, amountMinor, currency };
}

export type ErrorCategory =
  | "auth"
  | "credit"
  | "forbidden"
  | "invalid-request"
  | "unavailable-model"
  | "timeout"
  | "rate-limited"
  | "provider-unavailable"
  | "transport-error";

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  reason: string;
}

// Maps HTTP/transport failures to explicit recoverable categories. None of
// these may trigger a privacy-downgrade fallback; callers surface them.
export function classifyProviderError(httpStatus: number | null, retryAfterMs?: number): ClassifiedError {
  if (httpStatus === null) {
    return { category: "transport-error", retryable: true, reason: "network/timeout before HTTP status" };
  }
  if (httpStatus === 401) {
    return { category: "auth", retryable: false, reason: "invalid/missing API key (401)" };
  }
  if (httpStatus === 402) {
    return { category: "credit", retryable: false, reason: "insufficient credits, even for free models (402)" };
  }
  if (httpStatus === 403) {
    return { category: "forbidden", retryable: false, reason: "guardrail/moderation block (403)" };
  }
  if (httpStatus === 400) {
    return { category: "invalid-request", retryable: false, reason: "provider rejected request/model (400)" };
  }
  if (httpStatus === 404) {
    return { category: "unavailable-model", retryable: false, reason: "model id not available (404)" };
  }
  if (httpStatus === 408) {
    return { category: "timeout", retryable: true, reason: "provider request timeout (408)" };
  }
  if (httpStatus === 429) {
    const hint = retryAfterMs !== undefined ? ` retry-after ${retryAfterMs}ms` : "";
    return { category: "rate-limited", retryable: true, reason: `rate limited (429).${hint} back off, do not hammer` };
  }
  if (httpStatus >= 500) {
    return { category: "provider-unavailable", retryable: true, reason: `provider failure (${httpStatus})` };
  }
  return { category: "provider-unavailable", retryable: false, reason: `unexpected status (${httpStatus})` };
}

// Hard cap on synthetic live requests for the whole story.
export class RequestBudget {
  private used = 0;
  constructor(readonly max: number = PROBE_BUDGET.maxRequests) {}
  get spent(): number {
    return this.used;
  }
  consume(): boolean {
    if (this.used >= this.max) {
      return false;
    }
    this.used += 1;
    return true;
  }
}

export interface ProbeMessage {
  role: "system" | "user";
  content: string;
}

export interface ProbeRequest {
  model: string;
  messages: ProbeMessage[];
  maxTokens: number;
  tools?: unknown;
  toolChoice?: unknown;
  responseFormat?: unknown;
}

export interface ProbeAttempt {
  httpStatus: number | null;
  bodyText: string;
  transportError?: string;
}

export type ProbeTransport = (req: ProbeRequest, timeoutMs: number) => Promise<ProbeAttempt>;

export interface ProbeOutcome {
  attempts: number;
  // Final attempt when one was made; absent only when the budget was already spent.
  attempt?: ProbeAttempt;
  error?: ClassifiedError;
  budgetExhausted: boolean;
}

// Executes at most 1 + maxRetries attempts, one budget unit per attempt, and
// retries only retryable categories. Returns the last attempt either way so
// callers can assert on honest provider behavior instead of masking it.
export async function runBoundedProbe(
  transport: ProbeTransport,
  budget: RequestBudget,
  req: ProbeRequest,
  maxRetries: number = PROBE_BUDGET.maxRetriesPerProbe,
): Promise<ProbeOutcome> {
  let attempts = 0;
  let last: ProbeAttempt | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (!budget.consume()) {
      return { attempts, attempt: last, budgetExhausted: true };
    }
    attempts += 1;
    last = await transport(req, PROBE_BUDGET.timeoutMs);
    if (last.httpStatus !== null && last.httpStatus >= 200 && last.httpStatus < 300) {
      return { attempts, attempt: last, budgetExhausted: false };
    }
    const classified = classifyProviderError(last.httpStatus);
    if (!classified.retryable || attempt >= maxRetries) {
      return { attempts, attempt: last, error: classified, budgetExhausted: false };
    }
  }
  return { attempts, attempt: last, budgetExhausted: false };
}

// Live transport over global fetch. Synthetic prompts only; the key travels
// in the Authorization header and is never written to logs or reports.
export function liveTransport(apiKey: string): ProbeTransport {
  return async (req, timeoutMs) => {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
    };
    if (req.tools !== undefined) {
      body["tools"] = req.tools;
      body["tool_choice"] = req.toolChoice ?? "auto";
    }
    if (req.responseFormat !== undefined) {
      body["response_format"] = req.responseFormat;
    }
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { httpStatus: res.status, bodyText: await res.text() };
    } catch (err) {
      const name = err instanceof Error ? err.name : "unknown";
      return { httpStatus: null, bodyText: "", transportError: name };
    }
  };
}

export function toolProbeRequest(): ProbeRequest {
  return {
    model: SELECTED_DEV_MODEL.id,
    maxTokens: PROBE_BUDGET.maxOutputTokens,
    messages: [
      {
        role: "system",
        content: "You are a synthetic test helper. Use the provided tool for the memo.",
      },
      {
        role: "user",
        content: "Record a synthetic memo titled 'probe' for 1234 minor units of EUR.",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: SYNTHETIC_TOOL_NAME,
          description: "Record a synthetic memo (test only, no financial effect).",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string" },
              amountMinor: { type: "string", pattern: "^[0-9]+$" },
              currency: { type: "string", enum: ["EUR", "JPY", "KWD"] },
            },
            required: ["title", "amountMinor", "currency"],
            additionalProperties: false,
          },
        },
      },
    ],
    toolChoice: "auto",
  };
}

export function structuredProbeRequest(): ProbeRequest {
  return {
    model: SELECTED_DEV_MODEL.id,
    maxTokens: PROBE_BUDGET.maxOutputTokens,
    messages: [
      {
        role: "system",
        content: "Reply with exactly one JSON object, no other text.",
      },
      {
        role: "user",
        content: 'Emit {"title":"probe","amountMinor":"1234","currency":"EUR"}.',
      },
    ],
    responseFormat: { type: "json_object" },
  };
}

export function unavailableModelProbeRequest(): ProbeRequest {
  return {
    model: BOGUS_MODEL_ID,
    maxTokens: 16,
    messages: [{ role: "user", content: "synthetic availability probe" }],
  };
}
