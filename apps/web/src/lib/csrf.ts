/**
 * Issue 1.6 — CSRF + request-origin verification (Edge-safe: WebCrypto only).
 *
 * Layered mutation guard for `/api/*`:
 *  1. Double-submit CSRF token: `__Host-moneo_csrf` cookie (readable by our
 *     JS, `Secure; SameSite=Lax`, host-only) must equal the `x-csrf-token`
 *     header using a constant-time comparison. A cross-site attacker can
 *     neither read the cookie nor set the header.
 *  2. Origin verification: when `Origin`/`Referer` is present it must match
 *     the app origin. Missing headers fall through to layer 1 (non-browser
 *     clients), never to an allow.
 *  3. Fetch Metadata: a present `Sec-Fetch-Site: cross-site` on a mutation
 *     is rejected outright; missing headers fall through to layer 1.
 *
 * GET/HEAD/OPTIONS never require a token — and no GET handler in this app
 * performs a server-side write (login only redirects + sets a client-side
 * state cookie; metrics-free by design).
 */
export const CSRF_COOKIE = "__Host-moneo_csrf";
export const CSRF_HEADER = "x-csrf-token";
export const CSRF_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** True for methods that may change state and therefore need the guard. */
export function isMutationMethod(method: string): boolean {
  return MUTATION_METHODS.has(method.toUpperCase());
}

/** 32 random bytes, base64url. WebCrypto: runs on Edge + Node 22. */
export function issueCsrfToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Constant-time comparison over UTF-8 bytes (length check first). */
export function tokensMatch(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length || ab.length === 0) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i += 1) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export type CsrfFailure = "missing_cookie" | "missing_header" | "mismatch";

/** Double-submit check. Returns null when the pair is valid. */
export function validateCsrfToken(
  cookieToken: string | undefined,
  headerToken: string | null,
): CsrfFailure | null {
  if (!cookieToken) {
    return "missing_cookie";
  }
  if (!headerToken) {
    return "missing_header";
  }
  return tokensMatch(cookieToken, headerToken) ? null : "mismatch";
}

/**
 * Origin check. Rejects when a present Origin/Referer disagrees with the app
 * origin; returns "absent" when neither header exists (other layers decide).
 */
export function validateOrigin(
  origin: string | null,
  referer: string | null,
  appOrigin: string,
): "ok" | "absent" | "mismatch" {
  const candidate = origin ?? referer;
  if (!candidate) {
    return "absent";
  }
  let candidateOrigin: string;
  try {
    candidateOrigin = new URL(candidate).origin;
  } catch {
    return "mismatch";
  }
  return candidateOrigin.toLowerCase() === appOrigin.toLowerCase() ? "ok" : "mismatch";
}

/**
 * Fetch Metadata check. A present `cross-site` value on a mutation is a
 * forged cross-origin write attempt. Missing headers (curl, old browsers)
 * fall through to the CSRF layer.
 */
export function validateFetchMetadata(secFetchSite: string | null): "ok" | "absent" | "cross_site" {
  if (!secFetchSite) {
    return "absent";
  }
  return secFetchSite.toLowerCase() === "cross-site" ? "cross_site" : "ok";
}

export interface MutationGuardInput {
  method: string;
  cookieToken: string | undefined;
  headerToken: string | null;
  origin: string | null;
  referer: string | null;
  secFetchSite: string | null;
  appOrigin: string;
}

export type MutationGuardResult = { allowed: true } | { allowed: false; reason: string };

/** Full mutation gate: CSRF always, plus Origin/Fetch-Metadata when present. */
export function guardMutation(input: MutationGuardInput): MutationGuardResult {
  const csrf = validateCsrfToken(input.cookieToken, input.headerToken);
  if (csrf) {
    return { allowed: false, reason: `csrf_${csrf}` };
  }
  if (validateOrigin(input.origin, input.referer, input.appOrigin) === "mismatch") {
    return { allowed: false, reason: "origin_mismatch" };
  }
  if (validateFetchMetadata(input.secFetchSite) === "cross_site") {
    return { allowed: false, reason: "fetch_metadata_cross_site" };
  }
  return { allowed: true };
}

/** `Set-Cookie` value for the double-submit token (readable by our JS by design). */
export function csrfSetCookie(token: string, maxAge = CSRF_COOKIE_MAX_AGE): string {
  return `${CSRF_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax`;
}
