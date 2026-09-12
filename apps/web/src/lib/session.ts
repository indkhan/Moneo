import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Epoch 1, Issue 1.3 — sealed browser session.
 *
 * The browser holds ONE opaque cookie, `__Host-moneo_session`:
 * AES-256-GCM sealed JSON `{ sub, email, name, sid, iat, exp }`.
 * Access/refresh/ID tokens never leave the server: the callback route
 * exchanges the code over the backchannel and seals only profile claims.
 *
 * Cookie flags: `Secure; HttpOnly; Path=/; SameSite=Lax` with NO `Domain`
 * attribute. The `__Host-` prefix makes that host-only binding
 * browser-enforced (a `Domain=` value would be rejected outright).
 * `Secure` is unconditional — localhost counts as a trustworthy origin, so
 * local development over http://localhost keeps working.
 */
export const SESSION_COOKIE = "__Host-moneo_session";
export const OAUTH_STATE_COOKIE = "__Host-moneo_oauth_state";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export interface SessionPayload {
  /** Auth0 subject, e.g. `auth0|abc123`. */
  sub: string;
  email?: string;
  name?: string;
  /** Moneo user id from first-login provisioning (Issue 1.4). */
  uid?: string;
  /** Active workspace id from first-login provisioning (Issue 1.4). */
  wid?: string;
  /** Server-side session id (used by Issue 1.7 revocation). */
  sid: string;
  iat: number;
  exp: number;
}

export interface OAuthStatePayload {
  state: string;
  verifier: string;
  exp: number;
}

function keyFor(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/** Fresh server-side session id (the `sid` sealed into the cookie). */
export function newSessionId(): string {
  return randomBytes(16).toString("hex");
}

/** Seal a JSON payload. Format: `v1.<iv>.<ciphertext>.<tag>` (all base64url). */
export function seal(payload: unknown, secret: string): string {
  const key = keyFor(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(ciphertext)}.${b64urlEncode(tag)}`;
}

/** Verify + parse a sealed value. Returns null on any tampering, expiry handled by callers. */
export function unseal(sealed: string, secret: string): unknown {
  try {
    const parts = sealed.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") {
      return null;
    }
    const [, ivB64, ctB64, tagB64] = parts as [string, string, string, string];
    const key = keyFor(secret);
    const tag = b64urlDecode(tagB64);
    // GCM accepts shortened tags (weaker authenticity); sessions require full 128-bit tags.
    if (tag.length !== 16) {
      return null;
    }
    const decipher = createDecipheriv("aes-256-gcm", key, b64urlDecode(ivB64));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(b64urlDecode(ctB64)), decipher.final()]);
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    return parsed;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build the browser session payload from backchannel data. Token fields are
 * allow-list stripped here so a future refactor cannot accidentally seal
 * `access_token` / `refresh_token` / `id_token` into the browser cookie.
 */
export function buildSessionPayload(input: {
  sub: string;
  email?: unknown;
  name?: unknown;
  uid?: unknown;
  wid?: unknown;
  sid?: string;
  nowSeconds?: number;
  ttlSeconds?: number;
}): SessionPayload {
  if (typeof input.sub !== "string" || input.sub.length === 0) {
    throw new Error("Cannot mint a session without an Auth0 subject");
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? SESSION_TTL_SECONDS;
  const payload: SessionPayload = {
    sub: input.sub,
    sid: typeof input.sid === "string" && input.sid.length > 0 ? input.sid : newSessionId(),
    iat: now,
    exp: now + ttl,
  };
  if (typeof input.email === "string" && input.email.length > 0) {
    payload.email = input.email;
  }
  if (typeof input.name === "string" && input.name.length > 0) {
    payload.name = input.name;
  }
  if (typeof input.uid === "string" && input.uid.length > 0) {
    payload.uid = input.uid;
  }
  if (typeof input.wid === "string" && input.wid.length > 0) {
    payload.wid = input.wid;
  }
  return payload;
}

/** Assert that a freshly sealed session carries no token material. */
export function assertNoTokenMaterial(sealed: string, secret: string): void {
  const payload: unknown = unseal(sealed, secret);
  if (!isRecord(payload)) {
    throw new Error("Session cookie is not a sealed JSON object");
  }
  for (const forbidden of ["access_token", "refresh_token", "id_token", "token_type"]) {
    if (forbidden in payload) {
      throw new Error(`Session cookie must never contain ${forbidden}`);
    }
  }
}

/** Null unless the sealed payload is a live session (authentic + unexpired). */
export function readSession(
  sealed: string | undefined,
  secret: string,
  nowSeconds?: number,
): SessionPayload | null {
  if (!sealed) {
    return null;
  }
  const payload: unknown = unseal(sealed, secret);
  if (!isRecord(payload) || typeof payload.sub !== "string" || typeof payload.sid !== "string") {
    return null;
  }
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number" || payload.exp <= now) {
    return null;
  }
  const session: SessionPayload = {
    sub: payload.sub,
    sid: payload.sid,
    iat: payload.iat,
    exp: payload.exp,
  };
  if (typeof payload.email === "string") {
    session.email = payload.email;
  }
  if (typeof payload.name === "string") {
    session.name = payload.name;
  }
  if (typeof payload.uid === "string") {
    session.uid = payload.uid;
  }
  if (typeof payload.wid === "string") {
    session.wid = payload.wid;
  }
  return session;
}

/** Null unless the sealed value is a live OAuth state (authentic + unexpired). */
export function readOAuthState(
  sealed: string | undefined,
  secret: string,
  nowSeconds?: number,
): OAuthStatePayload | null {
  if (!sealed) {
    return null;
  }
  const payload: unknown = unseal(sealed, secret);
  if (
    !isRecord(payload) ||
    typeof payload.state !== "string" ||
    typeof payload.verifier !== "string"
  ) {
    return null;
  }
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    return null;
  }
  return { state: payload.state, verifier: payload.verifier, exp: payload.exp };
}

function cookieAttributes(maxAge: number): string {
  return `Path=/; Max-Age=${maxAge}; Expires=${new Date(Date.now() + maxAge * 1000).toUTCString()}; HttpOnly; Secure; SameSite=Lax`;
}

/** `Set-Cookie` value for the session. Never includes `Domain=` (host-only). */
export function sessionSetCookie(sealed: string, maxAge = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${sealed}; ${cookieAttributes(maxAge)}`;
}

/** `Set-Cookie` value that clears the session (identical flags, immediate expiry). */
export function sessionClearCookie(): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes(0)}`;
}

/** `Set-Cookie` value for the short-lived OAuth state (login CSRF + PKCE). */
export function oauthStateSetCookie(sealed: string): string {
  return `${OAUTH_STATE_COOKIE}=${sealed}; ${cookieAttributes(OAUTH_STATE_TTL_SECONDS)}`;
}

/** `Set-Cookie` value that clears the OAuth state. */
export function oauthStateClearCookie(): string {
  return `${OAUTH_STATE_COOKIE}=; ${cookieAttributes(0)}`;
}

/** Constant-time state comparison for the callback check. */
export function statesMatch(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
