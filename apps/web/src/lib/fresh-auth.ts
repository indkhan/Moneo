import { getSession } from "./auth-session";
import { requireStrongAuth, type StrongAuthContext } from "./strong-auth";

/** Sensitive credential changes require a provider authentication from the last five minutes. */
export const FRESH_AUTH_MAX_AGE_SECONDS = 5 * 60;

/**
 * `auth_time` is an OIDC claim set by Auth0 after authentication. Session
 * creation/renewal time is deliberately not accepted: renewing a cookie must
 * never satisfy a fresh-auth requirement.
 */
export function isFreshAuthTime(
  authTime: number | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = FRESH_AUTH_MAX_AGE_SECONDS,
): boolean {
  return (
    typeof authTime === "number" &&
    Number.isSafeInteger(authTime) &&
    authTime <= nowSeconds &&
    nowSeconds - authTime <= maxAgeSeconds
  );
}

/** A local return path only; Auth0 receives `prompt=login` and `max_age=0`. */
export function reauthenticateUrl(returnTo = "/settings"): string {
  const safeReturnTo =
    returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/settings";
  return `/auth/login?prompt=login&max_age=0&returnTo=${encodeURIComponent(safeReturnTo)}`;
}

export class FreshAuthError extends Error {
  readonly code = "FRESH_AUTH_REQUIRED";
  readonly reauthenticateUrl: string;

  constructor(returnTo?: string) {
    super("Reauthenticate to continue.");
    this.name = "FreshAuthError";
    this.reauthenticateUrl = reauthenticateUrl(returnTo);
  }
}

/** Requires both the normal strong-auth gate and a recent provider auth_time claim. */
export async function requireFreshAuth(returnTo?: string): Promise<StrongAuthContext> {
  const context = await requireStrongAuth();
  const session = await getSession();
  if (!isFreshAuthTime(session?.authTime)) {
    throw new FreshAuthError(returnTo);
  }
  return context;
}
