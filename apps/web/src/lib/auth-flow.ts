import { createHash, randomBytes } from "node:crypto";
import {
  type AuthConfig,
  authorizationEndpoint,
  callbackUrl,
  federatedLogoutEndpoint,
} from "./auth-config";
import {
  OAUTH_STATE_TTL_SECONDS,
  assertNoTokenMaterial,
  buildSessionPayload,
  newSessionId,
  oauthStateClearCookie,
  readOAuthState,
  seal,
  sessionClearCookie,
  statesMatch,
} from "./session";

/**
 * Epoch 1, Issue 1.3 — pure login/callback/logout flow.
 *
 * All browser-observable behaviour funnels through here; the Next.js route
 * files are thin adapters. Side effects (code exchange, profile fetch) are
 * injected so tests cover every branch without a network or Auth0 tenant.
 */
export interface LoginRedirect {
  /** Auth0 EU authorize URL (302 target). */
  url: string;
  /** Sealed OAuth state cookie value (login CSRF + PKCE verifier). */
  stateSealed: string;
}

export function buildLoginRedirect(
  config: AuthConfig,
  opts: { nowSeconds?: number; random?: (bytes: number) => Buffer } = {},
): LoginRedirect {
  const random = opts.random ?? randomBytes;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const state = random(32).toString("base64url");
  const verifier = random(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "utf8").digest().toString("base64url");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: callbackUrl(config),
    scope: "openid profile email",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return {
    url: `${authorizationEndpoint(config)}?${params.toString()}`,
    stateSealed: seal(
      { state, verifier, exp: now + OAUTH_STATE_TTL_SECONDS },
      config.sessionSecret,
    ),
  };
}

export interface CodeExchange {
  access_token: string;
  token_type: string;
  expires_in: number;
  /** Present in Auth0 responses but MUST never reach the browser. */
  id_token?: string;
  refresh_token?: string;
}

export interface UserProfile {
  sub: string;
  email?: unknown;
  name?: unknown;
}

/** Sentinel distinguishing a failed registration from a hook resolving nullish. */
const SESSION_REGISTRATION_FAILED = Symbol("session-registration-failed");

export type LoginResult =
  | {
      ok: true;
      sessionSealed: string;
      sid: string;
      uid: string | null;
      wid: string | null;
      redirectTo: string;
    }
  | {
      ok: false;
      error:
        | "invalid_state"
        | "invalid_request"
        | "exchange_failed"
        | "profile_failed"
        | "provisioning_failed"
        | "session_failed";
      redirectTo: string;
    };

/** Runtime shape check: a lying stub or broken provider must fail closed, not throw later. */
function isLiveTokenResponse(value: unknown): value is CodeExchange {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const accessToken: unknown = (value as { access_token?: unknown }).access_token;
  return typeof accessToken === "string" && accessToken.length > 0;
}

/** Runtime shape check for the userinfo payload. */
function isLiveProfile(value: unknown): value is UserProfile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const sub: unknown = (value as { sub?: unknown }).sub;
  return typeof sub === "string" && sub.length > 0;
}

/** Runtime shape check for the provisioning result (Issue 1.4). */
function isProvisionedIds(value: unknown): value is { uid: string; wid: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const ids = value as { uid?: unknown; wid?: unknown };
  return (
    typeof ids.uid === "string" &&
    ids.uid.length > 0 &&
    typeof ids.wid === "string" &&
    ids.wid.length > 0
  );
}

/**
 * Complete the Authorization Code + PKCE flow. Tokens stay server-side: only
 * `{ sub, email, name, sid, iat, exp }` is sealed into the browser cookie.
 */
export async function completeLogin(input: {
  config: AuthConfig;
  queryState: string | null;
  queryCode: string | null;
  stateCookie: string | undefined;
  nowSeconds?: number;
  /** Forwarded to session registration for audit context. */
  userAgent?: string | null;
  exchange: (code: string, verifier: string, redirectUri: string) => Promise<CodeExchange>;
  fetchProfile: (accessToken: string) => Promise<UserProfile>;
  /** Issue 1.4: resolve (or create) the user/workspace for this subject. */
  provision?: (profile: UserProfile) => Promise<{ uid: string; wid: string } | null>;
  /** Issue 1.7: persist the login server-side so it can be revoked. */
  registerSession?: (args: {
    sid: string;
    uid: string;
    wid: string;
    userAgent: string | null;
  }) => Promise<unknown>;
}): Promise<LoginResult> {
  const { config } = input;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const fail = (error: Exclude<LoginResult, { ok: true }>["error"]): LoginResult => ({
    ok: false,
    error,
    redirectTo: "/?auth_error=" + error,
  });

  const saved = readOAuthState(input.stateCookie, config.sessionSecret, now);
  if (!saved) {
    return fail("invalid_state");
  }
  if (!input.queryState || !statesMatch(saved.state, input.queryState)) {
    return fail("invalid_state");
  }
  if (!input.queryCode) {
    return fail("invalid_request");
  }

  const tokens: unknown = await input
    .exchange(input.queryCode, saved.verifier, callbackUrl(config))
    .catch((): null => null);
  if (!isLiveTokenResponse(tokens)) {
    return fail("exchange_failed");
  }

  const profile: unknown = await input.fetchProfile(tokens.access_token).catch((): null => null);
  if (!isLiveProfile(profile)) {
    return fail("profile_failed");
  }

  let provisioned: { uid: string; wid: string } | null = null;
  if (input.provision) {
    const settled: unknown = await input.provision(profile).catch((): null => null);
    if (!isProvisionedIds(settled)) {
      return fail("provisioning_failed");
    }
    provisioned = settled;
  }

  // The sid is minted before sealing so login can be registered server-side
  // (Issue 1.7) under the same id the cookie carries.
  const sid = newSessionId();
  if (input.registerSession && provisioned) {
    const registered: unknown = await input
      .registerSession({
        sid,
        uid: provisioned.uid,
        wid: provisioned.wid,
        userAgent: input.userAgent ?? null,
      })
      .catch(() => SESSION_REGISTRATION_FAILED);
    if (registered === SESSION_REGISTRATION_FAILED) {
      return fail("session_failed");
    }
  }

  const sessionSealed = seal(
    buildSessionPayload({ ...profile, ...provisioned, sid, nowSeconds: now }),
    config.sessionSecret,
  );
  assertNoTokenMaterial(sessionSealed, config.sessionSecret);
  return {
    ok: true,
    sessionSealed,
    sid,
    uid: provisioned?.uid ?? null,
    wid: provisioned?.wid ?? null,
    redirectTo: "/home",
  };
}

export interface LogoutRedirect {
  /** Auth0 EU logout URL that ends the IdP session, then returns to baseUrl. */
  url: string;
  clearCookie: string;
  clearStateCookie: string;
}

export function buildLogoutRedirect(config: AuthConfig): LogoutRedirect {
  const params = new URLSearchParams({
    client_id: config.clientId,
    returnTo: config.baseUrl,
  });
  return {
    url: `${federatedLogoutEndpoint(config)}?${params.toString()}`,
    clearCookie: sessionClearCookie(),
    clearStateCookie: oauthStateClearCookie(),
  };
}

/** Minimal cookie parser for server routes (single header value, no deps). */
export { cookieValue } from "./cookies";
