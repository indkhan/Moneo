import { cookieValue } from "./cookies";
import { CSRF_COOKIE, CSRF_HEADER } from "./csrf";

/**
 * Issue 1.7 — typed browser client for the session APIs.
 *
 * `fetchImpl` is injected (`globalThis.fetch` in components, a stub in
 * tests) so every status mapping and header is covered without a server.
 */
export interface SessionListItem {
  id: string;
  workspaceId: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export class SessionApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SessionApiError";
    this.status = status;
  }
}

/**
 * Minimal fetch surface the session APIs need. Narrower than `typeof fetch`
 * so tests can stub it with plain `(url, init)` functions; `globalThis.fetch`
 * satisfies it structurally.
 */
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** Read our CSRF token out of `document.cookie` for mutation headers. */
export function readCsrfToken(documentCookie: string): string | undefined {
  return cookieValue(documentCookie, CSRF_COOKIE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseJson(response: Response, what: string): Promise<Record<string, unknown>> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new SessionApiError(response.status, `${what} returned non-JSON`);
  }
  if (!isRecord(body)) {
    throw new SessionApiError(response.status, `${what} returned an unexpected shape`);
  }
  return body;
}

function toSessionListItem(value: unknown): SessionListItem {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new SessionApiError(200, "Session list returned an unexpected shape");
  }
  return {
    id: value.id,
    workspaceId: typeof value.workspaceId === "string" ? value.workspaceId : null,
    userAgent: typeof value.userAgent === "string" ? value.userAgent : null,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    lastSeenAt: typeof value.lastSeenAt === "string" ? value.lastSeenAt : "",
    current: value.current === true,
  };
}

/** List the caller's sessions. Throws SessionApiError(401) when logged out. */
export async function listSessions(
  fetchImpl: FetchImpl,
  csrfToken: string | undefined,
): Promise<SessionListItem[]> {
  const response = await fetchImpl("/api/v1/sessions", {
    headers: csrfToken ? { [CSRF_HEADER]: csrfToken } : undefined,
  });
  if (response.status === 401) {
    throw new SessionApiError(401, "Not signed in");
  }
  if (!response.ok) {
    throw new SessionApiError(response.status, "Could not load sessions");
  }
  const body = await parseJson(response, "Session list");
  if (!Array.isArray(body.sessions)) {
    throw new SessionApiError(response.status, "Session list returned an unexpected shape");
  }
  return body.sessions.map(toSessionListItem);
}

async function postRevocation(
  fetchImpl: FetchImpl,
  csrfToken: string | undefined,
  body: Record<string, unknown>,
  what: string,
): Promise<{ revoked: number }> {
  const response = await fetchImpl("/api/v1/sessions/revoke", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(csrfToken ? { [CSRF_HEADER]: csrfToken } : {}),
    },
    body: JSON.stringify(body),
  });
  if (response.status === 401) {
    throw new SessionApiError(401, "Not signed in");
  }
  if (!response.ok) {
    throw new SessionApiError(response.status, `${what} failed`);
  }
  const parsed = await parseJson(response, what);
  if (typeof parsed.revoked !== "number") {
    throw new SessionApiError(response.status, `${what} returned an unexpected shape`);
  }
  return { revoked: parsed.revoked };
}

/** Revoke exactly one owned session. */
export function revokeSession(
  fetchImpl: FetchImpl,
  csrfToken: string | undefined,
  sessionId: string,
): Promise<{ revoked: number }> {
  return postRevocation(fetchImpl, csrfToken, { sessionId }, "Revoke session");
}

/** Revoke every session except the caller's own. */
export function revokeOtherSessions(
  fetchImpl: FetchImpl,
  csrfToken: string | undefined,
): Promise<{ revoked: number }> {
  return postRevocation(fetchImpl, csrfToken, { allOthers: true }, "Sign out others");
}

/** Revoke every Moneo session before the official SDK ends the Auth0 session. */
export function revokeAllSessions(
  fetchImpl: FetchImpl,
  csrfToken: string | undefined,
): Promise<{ revoked: number }> {
  return postRevocation(fetchImpl, csrfToken, { all: true }, "Sign out");
}
