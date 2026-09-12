import type { AppEnv } from "@moneo/shared/env";

/**
 * Epoch 1, Issue 1.3 — Auth0 EU tenant configuration.
 *
 * Data-residency rule: the canonical issuer MUST be an EU tenant,
 * `https://<tenant>.eu.auth0.com/` or `https://<tenant>.eu-2.auth0.com/`.
 * A custom login domain is supported for
 * branding, but tokens are always validated against the canonical EU issuer,
 * so a misconfigured custom domain can never move authentication or profile
 * data to another region.
 */
export interface AuthConfig {
  /** Canonical EU issuer, e.g. `https://moneo.eu.auth0.com`. */
  issuer: string;
  /** Host users see on the login page; defaults to the canonical domain. */
  loginHost: string;
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

/** True only for `<tenant>.eu.auth0.com` (exact suffix, https implied by construction). */
export function isEuAuth0Domain(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) {
    return false;
  }
  const lower = domain.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.eu(?:-2)?\.auth0\.com$/.test(lower)) {
    return false;
  }
  // Reject the bare regional suffix with no tenant label.
  return lower !== "eu.auth0.com";
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

/**
 * Build validated auth config from env. Throws AuthConfigError (never a
 * Zod dump or secret-bearing message) when auth is misconfigured.
 */
export function loadAuthConfig(env: AppEnv): AuthConfig {
  const { AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_CUSTOM_DOMAIN, APP_BASE_URL } =
    env;
  if (!AUTH0_DOMAIN || !isEuAuth0Domain(AUTH0_DOMAIN)) {
    throw new AuthConfigError(
      "AUTH0_DOMAIN must be an EU tenant domain like <tenant>.eu.auth0.com",
    );
  }
  if (!AUTH0_CLIENT_ID) {
    throw new AuthConfigError("AUTH0_CLIENT_ID is required for browser login");
  }
  if (!AUTH0_CLIENT_SECRET) {
    throw new AuthConfigError("AUTH0_CLIENT_SECRET is required for the server-side code exchange");
  }
  if (AUTH0_CUSTOM_DOMAIN && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(AUTH0_CUSTOM_DOMAIN)) {
    throw new AuthConfigError("AUTH0_CUSTOM_DOMAIN must be a plain hostname");
  }
  const issuer = `https://${AUTH0_DOMAIN.toLowerCase()}`;
  const loginHost = AUTH0_CUSTOM_DOMAIN ? `https://${AUTH0_CUSTOM_DOMAIN.toLowerCase()}` : issuer;
  return {
    issuer,
    loginHost,
    clientId: AUTH0_CLIENT_ID,
    clientSecret: AUTH0_CLIENT_SECRET,
    baseUrl: APP_BASE_URL.replace(/\/$/, ""),
  };
}
