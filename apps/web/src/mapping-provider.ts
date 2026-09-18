// E02-S04 bounded mapping-model transport (architecture ##53, 74, 76,
// 190-192; E00-S05 probe precedent). Exactly one OpenRouter chat request
// per mapping (plus at most one retry for retryable statuses) sharing a
// single token reservation; strict local validation owns acceptance — the
// model proposes, deterministic code disposes. The sample carries header +
// raw staged cells only: never account names/ids, secrets, bytes or full
// files. Ordinary logs record model/version/token metadata + reason codes,
// never prompts, rows or responses.

import type { Pool } from "pg";
import { isUuid, uuidv7 } from "./ids.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "./tenancy.ts";
import { validateImportProfile } from "./uploads.ts";
import type { UploadProfile } from "./uploads.ts";

export const MAPPING_INPUT_CEILING = 8000;
export const MAPPING_OUTPUT_CEILING = 2000;
export const MAPPING_RESERVATION_TTL_MIN = 10;
export const MAPPING_MODEL_DEFAULT = "liquid/lfm-2.5-2.6b:free";

export type MappingTransportRequest = {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
};

export type MappingTransportAttempt = { httpStatus: number | null; bodyText: string; retryAfterMs?: number };

export type MappingTransport = (req: MappingTransportRequest, timeoutMs: number) => Promise<MappingTransportAttempt>;

export type ProviderErrorClass =
  | "auth" | "credits" | "forbidden" | "invalid-request" | "unavailable-model"
  | "timeout" | "rate-limited" | "provider-unavailable" | "transport-error" | "malformed-output";

export type ClassifiedProviderError = { category: ProviderErrorClass; retryable: boolean };

export function classifyMappingError(httpStatus: number | null): ClassifiedProviderError {
  if (httpStatus === null) return { category: "transport-error", retryable: true };
  if (httpStatus === 401) return { category: "auth", retryable: false };
  if (httpStatus === 402) return { category: "credits", retryable: false };
  if (httpStatus === 403) return { category: "forbidden", retryable: false };
  if (httpStatus === 400) return { category: "invalid-request", retryable: false };
  if (httpStatus === 404) return { category: "unavailable-model", retryable: false };
  if (httpStatus === 408) return { category: "timeout", retryable: true };
  if (httpStatus === 429) return { category: "rate-limited", retryable: true };
  if (httpStatus >= 500) return { category: "provider-unavailable", retryable: true };
  return { category: "provider-unavailable", retryable: false };
}

export type LiveProviderConfig = { apiKey: string; baseUrl: string; model: string };

/** Fail-closed loader: AI assistance is off unless explicitly configured. */
export function loadMappingProvider(): LiveProviderConfig | null {
  if (process.env["MAPPING_AI_ENABLED"] !== "1") return null;
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: process.env["OPENROUTER_BASE_URL"] ?? "https://openrouter.ai/api/v1",
    model: process.env["OPENROUTER_MODEL"] ?? MAPPING_MODEL_DEFAULT,
  };
}

/** Live OpenRouter chat transport: key travels in the header only, 30 s cap. */
export function liveMappingTransport(config: LiveProviderConfig): MappingTransport {
  return async (req, timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: req.model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          max_tokens: req.maxOutputTokens,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      const retryAfter = res.headers.get("retry-after");
      const retryAfterMs = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
      return { httpStatus: res.status, bodyText: await res.text(), retryAfterMs };
    } catch (err) {
      if ((err as Error).name === "AbortError") return { httpStatus: 408, bodyText: "" };
      return { httpStatus: null, bodyText: "" };
    } finally {
      clearTimeout(timer);
    }
  };
}

export type ValidatedMapping = { profile: UploadProfile; notes: string };

// Strict output contract: exactly {profile, notes?}; the profile must pass
// the same allowlist validation as manual input, and callers additionally
// require every mapped column to exist in the staged header.
export function validateModelMapping(value: unknown): ValidatedMapping {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("model-output-not-object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "profile" && key !== "notes") throw new Error(`model-output-unknown-field:${key}`);
  }
  const profile = validateImportProfile(record["profile"]);
  const notes = record["notes"];
  if (notes !== undefined && (typeof notes !== "string" || notes.length > 500)) throw new Error("model-output-bad-notes");
  return { profile, notes: typeof notes === "string" ? notes : "" };
}

export function parseModelBody(bodyText: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error("model-output-not-json");
  }
  // Accept OpenRouter chat envelope or bare JSON (stub transports use bare).
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "choices" in parsed) {
    const choices = (parsed as { choices: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) throw new Error("model-output-no-choices");
    const message = (choices[0] as { message?: { content?: unknown } }).message;
    const content = message?.content;
    if (typeof content !== "string") throw new Error("model-output-no-content");
    try {
      return JSON.parse(content) as unknown;
    } catch {
      throw new Error("model-output-content-not-json");
    }
  }
  return parsed;
}

export type Reservation = { id: string; model: string };

// Claim the hard token ceiling before dispatch. Concurrency caps are
// enforced here: one active reservation per import, two per workspace.
// Active = RESERVED and unexpired; terminal states never block.
export async function reserveMappingCall(
  pool: Pool,
  claims: TenantClaims,
  importId: string,
  model: string,
): Promise<Reservation> {
  if (!isUuid(importId)) throw new TenantDenied();
  if (typeof model !== "string" || model.length < 1 || model.length > 200) throw new TenantInvalid();
  return withTenant(pool, claims, async (client) => {
    const own = await client.query("SELECT 1 FROM imports WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, importId]);
    if ((own.rowCount ?? 0) === 0) throw new TenantDenied();
    const perImport = await client.query(
      "SELECT count(*)::int AS n FROM mapping_provider_reservations WHERE workspace_id = $1 AND import_id = $2 AND status = 'RESERVED' AND expires_at > now()",
      [claims.workspaceId, importId],
    );
    if (((perImport.rows[0] as { n: number }).n) >= 1) throw new Error("mapping_busy");
    const perWorkspace = await client.query(
      "SELECT count(*)::int AS n FROM mapping_provider_reservations WHERE workspace_id = $1 AND status = 'RESERVED' AND expires_at > now()",
      [claims.workspaceId],
    );
    if (((perWorkspace.rows[0] as { n: number }).n) >= 2) throw new Error("mapping_busy");
    const id = uuidv7();
    await client.query(
      "INSERT INTO mapping_provider_reservations (workspace_id, id, import_id, purpose, input_ceiling, output_ceiling, status, model, expires_at) VALUES ($1, $2, $3, 'import-mapping', $4, $5, 'RESERVED', $6, now() + ($7 || ' minutes')::interval)",
      [claims.workspaceId, id, importId, MAPPING_INPUT_CEILING, MAPPING_OUTPUT_CEILING, model, "10"],
    );
    return { id, model };
  });
}

export type ConsumedCall = {
  usage: { inputTokens: number | null; outputTokens: number | null; costUnknown: boolean };
};

// Record provider-reported usage (or unknown/pending, never zero) and mark
// the reservation CONSUMED. Spend is recorded whether or not validation
// later accepts the output.
export async function consumeReservation(
  pool: Pool,
  claims: TenantClaims,
  reservationId: string,
  usage: { model: string; inputTokens: number | null; outputTokens: number | null },
): Promise<ConsumedCall> {
  if (!isUuid(reservationId)) throw new TenantDenied();
  return withTenant(pool, claims, async (client) => {
    const found = await client.query("SELECT status FROM mapping_provider_reservations WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [
      claims.workspaceId,
      reservationId,
    ]);
    if ((found.rowCount ?? 0) === 0) throw new TenantDenied();
    if ((found.rows[0] as { status: string }).status !== "RESERVED") throw new Error("reservation_settled");
    const costUnknown = usage.inputTokens === null || usage.outputTokens === null;
    await client.query(
      "INSERT INTO mapping_provider_usage (workspace_id, id, reservation_id, model, input_tokens, output_tokens, cost_unknown) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [claims.workspaceId, uuidv7(), reservationId, usage.model, usage.inputTokens, usage.outputTokens, costUnknown],
    );
    await client.query("UPDATE mapping_provider_reservations SET status = 'CONSUMED' WHERE workspace_id = $1 AND id = $2", [
      claims.workspaceId,
      reservationId,
    ]);
    return { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUnknown } };
  });
}

/** Release a reservation no request spent (budget untouched, slot freed). */
export async function releaseReservation(pool: Pool, claims: TenantClaims, reservationId: string): Promise<void> {
  if (!isUuid(reservationId)) throw new TenantDenied();
  await withTenant(pool, claims, async (client) => {
    await client.query("UPDATE mapping_provider_reservations SET status = 'RELEASED' WHERE workspace_id = $1 AND id = $2 AND status = 'RESERVED'", [
      claims.workspaceId,
      reservationId,
    ]);
  });
}

export function extractUsage(bodyText: string, model: string): { model: string; inputTokens: number | null; outputTokens: number | null } {
  try {
    const parsed = JSON.parse(bodyText) as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    const input = parsed?.usage?.prompt_tokens;
    const output = parsed?.usage?.completion_tokens;
    return {
      model,
      inputTokens: typeof input === "number" && Number.isInteger(input) && input >= 0 ? input : null,
      outputTokens: typeof output === "number" && Number.isInteger(output) && output >= 0 ? output : null,
    };
  } catch {
    return { model, inputTokens: null, outputTokens: null };
  }
}
