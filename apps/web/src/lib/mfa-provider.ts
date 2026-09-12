import type { AuthConfig } from "./auth-config";

/**
 * Issue 1.8 — provider-backed strong authentication (Auth0 Management API).
 *
 * No custom TOTP/passkey system: enrollment, verification and recovery all
 * run through the provider. This module is the backchannel client the server
 * uses to (a) list a user's enrolled factors, (b) mint a provider-hosted
 * enrollment ticket, and (c) resolve whether passkeys are offered. `fetchImpl`
 * is injected so tests cover every branch without a live tenant.
 */

export type FactorKind = "passkey" | "totp" | "guardian" | "sms" | "email";

export interface AuthFactor {
  id: string;
  kind: FactorKind | "recovery-code" | "other";
  /** Raw provider type for audit display, e.g. `webauthn-platform`. */
  providerType: string;
  confirmed: boolean;
}

export class MfaProviderError extends Error {
  readonly code: "UNAVAILABLE" | "UNAUTHORIZED" | "NOT_FOUND";

  constructor(code: MfaProviderError["code"], message: string) {
    super(message);
    this.name = "MfaProviderError";
    this.code = code;
  }
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface ManagementCredentials {
  clientId: string;
  clientSecret: string;
}

function mapFactorType(providerType: unknown): AuthFactor["kind"] {
  switch (providerType) {
    case "webauthn-platform":
    case "webauthn-roaming":
      return "passkey";
    case "totp":
      return "totp";
    case "guardian":
    case "push-notification":
      return "guardian";
    case "sms":
      return "sms";
    case "email":
      return "email";
    case "recovery-code":
      return "recovery-code";
    default:
      return "other";
  }
}

function throwForStatus(status: number, what: string): never {
  if (status === 401 || status === 403) {
    throw new MfaProviderError("UNAUTHORIZED", `${what}: provider credentials rejected`);
  }
  if (status === 404) {
    throw new MfaProviderError("NOT_FOUND", `${what}: unknown identity`);
  }
  throw new MfaProviderError("UNAVAILABLE", `${what}: provider responded ${status}`);
}

async function parseJson(response: Response, what: string): Promise<unknown> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new MfaProviderError("UNAVAILABLE", `${what}: provider returned non-JSON`);
  }
  return body;
}

/** In-memory Management API token; per-process, expiry-aware, never logged. */
export class ManagementTokenCache {
  private token: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly config: AuthConfig,
    private readonly credentials: ManagementCredentials,
    private readonly fetchImpl: FetchImpl,
  ) {}

  async tokenFor(nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
    if (this.token && nowSeconds < this.expiresAt - 30) {
      return this.token;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: this.credentials.clientId,
          client_secret: this.credentials.clientSecret,
          audience: `${this.config.issuer}/api/v2/`,
        }),
      });
    } catch {
      throw new MfaProviderError("UNAVAILABLE", "Management token grant unreachable");
    }
    if (!response.ok) {
      throwForStatus(response.status, "Management token grant");
    }
    const body = (await parseJson(response, "Management token grant")) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      throw new MfaProviderError("UNAVAILABLE", "Management token grant returned no token");
    }
    this.token = body.access_token;
    const ttl = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 300;
    this.expiresAt = nowSeconds + ttl;
    return this.token;
  }

  /** Test hook: forget the cached token. */
  clear(): void {
    this.token = null;
    this.expiresAt = 0;
  }
}

export interface MfaProvider {
  /** Live enrolled factors for an Auth0 user id (= our session `sub`). */
  listFactors(userId: string): Promise<AuthFactor[]>;
  /** Provider-hosted enrollment flow URL (passkey where supported, else TOTP). */
  enrollmentTicket(userId: string): Promise<{ ticketUrl: string }>;
  /** Whether this tenant offers passkey setup (env capability flag). */
  passkeysOffered(): boolean;
}

export class Auth0MfaProvider implements MfaProvider {
  constructor(
    private readonly config: AuthConfig,
    private readonly tokens: ManagementTokenCache,
    private readonly fetchImpl: FetchImpl,
    private readonly passkeysEnabled: boolean,
  ) {}

  passkeysOffered(): boolean {
    return this.passkeysEnabled;
  }

  private async authorized(path: string): Promise<Response> {
    const token = await this.tokens.tokenFor();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.issuer}/api/v2${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      throw new MfaProviderError("UNAVAILABLE", `Management API ${path} unreachable`);
    }
    return response;
  }

  async listFactors(userId: string): Promise<AuthFactor[]> {
    if (!userId) {
      throw new MfaProviderError("NOT_FOUND", "Cannot list factors without a user id");
    }
    const response = await this.authorized(
      `/users/${encodeURIComponent(userId)}/authentication-methods`,
    );
    if (!response.ok) {
      throwForStatus(response.status, "Factor listing");
    }
    const body = await parseJson(response, "Factor listing");
    if (!Array.isArray(body)) {
      throw new MfaProviderError("UNAVAILABLE", "Factor listing returned an unexpected shape");
    }
    return body
      .filter(
        (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
      )
      .map((entry) => ({
        id: typeof entry.id === "string" ? entry.id : "",
        kind: mapFactorType(entry.type),
        providerType: typeof entry.type === "string" ? entry.type : "unknown",
        confirmed: entry.confirmed !== false,
      }));
  }

  async enrollmentTicket(userId: string): Promise<{ ticketUrl: string }> {
    if (!userId) {
      throw new MfaProviderError("NOT_FOUND", "Cannot ticket enrollment without a user id");
    }
    const token = await this.tokens.tokenFor();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.issuer}/api/v2/guardian/enrollments/ticket`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ user_id: userId }),
      });
    } catch {
      throw new MfaProviderError("UNAVAILABLE", "Enrollment ticket endpoint unreachable");
    }
    if (!response.ok) {
      throwForStatus(response.status, "Enrollment ticket");
    }
    const body = (await parseJson(response, "Enrollment ticket")) as { ticket_url?: unknown };
    if (typeof body.ticket_url !== "string" || body.ticket_url.length === 0) {
      throw new MfaProviderError("UNAVAILABLE", "Enrollment ticket returned no URL");
    }
    return { ticketUrl: body.ticket_url };
  }
}

/** Passkeys are offered unless explicitly opted out (`"false"`/`"0"`/`"no"`). */
export function passkeysEnabled(raw: string | undefined): boolean {
  if (raw === undefined) {
    return true;
  }
  return !["false", "0", "no"].includes(raw.trim().toLowerCase());
}

/** Management credentials: dedicated pair when set, else the base pair. */
export function managementCredentials(input: {
  clientId: string;
  clientSecret: string;
  managementClientId?: string;
  managementClientSecret?: string;
}): ManagementCredentials {
  const clientId = input.managementClientId ?? input.clientId;
  const clientSecret = input.managementClientSecret ?? input.clientSecret;
  if (!clientId || !clientSecret) {
    throw new MfaProviderError("UNAUTHORIZED", "Management API credentials are not configured");
  }
  return { clientId, clientSecret };
}
