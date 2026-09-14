import { getDb } from "@moneo/db/client";
import { listUserSessions } from "@moneo/db/sessions";
import { loadEnv } from "@moneo/shared/env";
import { loadAuthConfig } from "./auth-config";
import { getSession } from "./auth-session";
import {
  Auth0MfaProvider,
  ManagementTokenCache,
  MfaProviderError,
  managementCredentials,
  passkeysEnabled,
  type AuthFactor,
  type MfaProvider,
} from "./mfa-provider";
import type { SessionPayload } from "./auth-session";

/**
 * Issue 1.8 — strong-authentication enrollment gate.
 *
 * Finance access (imports today, every finance route from here on) requires
 * ALL of: a live sealed session, a non-revoked registry row, and a
 * provider-verified enrolled factor. Provider trouble fails CLOSED
 * (`degraded: true`): the UI may explain, but never unlock.
 *
 * Enrollment alone is not step-up authentication — E18 adds fresh-auth
 * checks for sensitive actions on top of this gate.
 */

export type StrongAuthMethod = "passkey" | "totp";

export interface StrongAuthStatus {
  state: "enrolled" | "not-enrolled" | "degraded" | "signed-out";
  /** Primary enrolled factor kind, when enrolled. */
  method: StrongAuthMethod | null;
  factors: AuthFactor[];
  passkeysOffered: boolean;
}

const PRIMARY_METHODS: ReadonlySet<AuthFactor["kind"]> = new Set(["passkey", "totp"]);

/** Recovery codes alone never enroll: they accompany a primary factor. */
export function primaryFactor(factors: AuthFactor[]): AuthFactor | null {
  return factors.find((f) => f.confirmed && PRIMARY_METHODS.has(f.kind)) ?? null;
}

export function decideStrongAuth(
  session: SessionPayload | null,
  sessionActive: boolean,
  factors: AuthFactor[] | null,
  providerFailed: boolean,
  passkeysOffered: boolean,
): StrongAuthStatus {
  if (!session) {
    return { state: "signed-out", method: null, factors: [], passkeysOffered };
  }
  if (!sessionActive) {
    // Expired SDK sessions never reach here; this is registry revocation.
    return { state: "signed-out", method: null, factors: [], passkeysOffered };
  }
  if (providerFailed || factors === null) {
    return { state: "degraded", method: null, factors: [], passkeysOffered };
  }
  const primary = primaryFactor(factors);
  if (!primary || !isStrongAuthMethod(primary.kind)) {
    return { state: "not-enrolled", method: null, factors, passkeysOffered };
  }
  return { state: "enrolled", method: primary.kind, factors, passkeysOffered };
}

function isStrongAuthMethod(kind: AuthFactor["kind"]): kind is StrongAuthMethod {
  return PRIMARY_METHODS.has(kind);
}

export class StrongAuthError extends Error {
  readonly code: "SIGNED_OUT" | "NOT_ENROLLED" | "DEGRADED";

  constructor(code: StrongAuthError["code"], message: string) {
    super(message);
    this.name = "StrongAuthError";
    this.code = code;
  }
}

export interface StrongAuthContext {
  session: SessionPayload;
  status: StrongAuthStatus;
}

/** Build the provider from env (throws AuthConfigError when auth is unset). */
export function providerFromEnv(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): MfaProvider {
  const env = loadEnv();
  const config = loadAuthConfig(env);
  const credentials = managementCredentials({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    managementClientId: env.AUTH0_MANAGEMENT_CLIENT_ID,
    managementClientSecret: env.AUTH0_MANAGEMENT_CLIENT_SECRET,
  });
  const tokens = new ManagementTokenCache(config, credentials, fetchImpl);
  return new Auth0MfaProvider(
    config,
    tokens,
    fetchImpl,
    passkeysEnabled(env.AUTH0_PASSKEYS_ENABLED),
  );
}

/**
 * Resolve enrollment status: sealed session → registry liveness → provider
 * factors. Never throws for provider trouble (degraded instead); throws only
 * when auth itself is unconfigured.
 */
export async function resolveStrongAuthStatus(
  provider: MfaProvider,
  nowSeconds?: number,
): Promise<StrongAuthStatus> {
  const session = await getSession(nowSeconds);
  if (!session?.uid) {
    return decideStrongAuth(null, false, null, false, provider.passkeysOffered());
  }
  const actives = await listUserSessions(getDb(), session.uid);
  if (!actives.some((s) => s.id === session.sid)) {
    return decideStrongAuth(session, false, null, false, provider.passkeysOffered());
  }
  let factors: AuthFactor[] | null = null;
  let failed = false;
  try {
    factors = await provider.listFactors(session.sub);
  } catch (error) {
    if (!(error instanceof MfaProviderError)) {
      throw error;
    }
    failed = true;
  }
  return decideStrongAuth(session, true, factors, failed, provider.passkeysOffered());
}

/**
 * Gate for finance mutations and workspace finance reads. Resolves on
 * success; throws StrongAuthError otherwise. Use at the top of every finance
 * route handler from Epoch 3 on — fresh users cannot bypass setup via direct
 * API requests because the provider, not the client, attests enrollment.
 */
export async function requireStrongAuth(provider?: MfaProvider): Promise<StrongAuthContext> {
  const resolved = provider ?? providerFromEnv();
  const session = await getSession();
  if (!session?.uid) {
    throw new StrongAuthError("SIGNED_OUT", "Sign in to continue.");
  }
  const actives = await listUserSessions(getDb(), session.uid);
  if (!actives.some((s) => s.id === session.sid)) {
    throw new StrongAuthError("SIGNED_OUT", "This session is no longer active. Sign in again.");
  }
  let factors: AuthFactor[];
  try {
    factors = await resolved.listFactors(session.sub);
  } catch (error) {
    if (error instanceof MfaProviderError) {
      throw new StrongAuthError(
        "DEGRADED",
        "Could not verify strong authentication. Try again — access stays locked.",
      );
    }
    throw error;
  }
  const status = decideStrongAuth(session, true, factors, false, resolved.passkeysOffered());
  if (status.state !== "enrolled") {
    throw new StrongAuthError(
      "NOT_ENROLLED",
      "Set up strong authentication to unlock finance access.",
    );
  }
  return { session, status };
}
