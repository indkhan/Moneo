import type { FetchImpl } from "./sessions-client";
import { SessionApiError } from "./sessions-client";

/**
 * Issue 1.8 — typed browser client for the strong-auth endpoints.
 * `fetchImpl` is injected (`globalThis.fetch` in components, stub in tests).
 */
export type StrongAuthState = "enrolled" | "not-enrolled" | "degraded" | "signed-out";

export interface StrongAuthStatusBody {
  state: StrongAuthState;
  method: string | null;
  factors: Array<{ id: string; kind: string; providerType: string; confirmed: boolean }>;
  passkeysOffered: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFactor(value: unknown): StrongAuthStatusBody["factors"][number] {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new SessionApiError(200, "Status endpoint returned an unexpected shape");
  }
  return {
    id: value.id,
    kind: typeof value.kind === "string" ? value.kind : "other",
    providerType: typeof value.providerType === "string" ? value.providerType : "unknown",
    confirmed: value.confirmed === true,
  };
}

/** Enrollment status for the current browser session. */
export async function fetchStrongAuthStatus(fetchImpl: FetchImpl): Promise<StrongAuthStatusBody> {
  const response = await fetchImpl("/api/v1/auth/factors");
  if (!response.ok) {
    throw new SessionApiError(response.status, "Could not load strong-auth status");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new SessionApiError(response.status, "Status endpoint returned non-JSON");
  }
  if (
    !isRecord(body) ||
    typeof body.state !== "string" ||
    !["enrolled", "not-enrolled", "degraded", "signed-out"].includes(body.state) ||
    !Array.isArray(body.factors) ||
    typeof body.passkeysOffered !== "boolean"
  ) {
    throw new SessionApiError(response.status, "Status endpoint returned an unexpected shape");
  }
  return {
    state: body.state as StrongAuthState,
    method: typeof body.method === "string" ? body.method : null,
    factors: body.factors.map(toFactor),
    passkeysOffered: body.passkeysOffered,
  };
}

/** Mint a provider-hosted enrollment URL. Throws on passkey_unsupported (use totp). */
export async function requestEnrollmentTicket(
  fetchImpl: FetchImpl,
  csrfToken: string | undefined,
  kind: "passkey" | "totp",
): Promise<{ ticketUrl: string }> {
  const response = await fetchImpl("/api/v1/auth/enrollment-ticket", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
    },
    body: JSON.stringify({ kind }),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new SessionApiError(response.status, "Ticket endpoint returned non-JSON");
  }
  if (!response.ok) {
    const code = isRecord(body) && typeof body.error === "string" ? body.error : "ticket_failed";
    throw new SessionApiError(response.status, `Enrollment ticket failed: ${code}`);
  }
  if (!isRecord(body) || typeof body.ticketUrl !== "string") {
    throw new SessionApiError(response.status, "Ticket endpoint returned an unexpected shape");
  }
  return { ticketUrl: body.ticketUrl };
}
