import { loadEnv } from "@moneo/shared/env";
import { cookies } from "next/headers";
import { loadAuthConfig, type AuthConfig } from "./auth-config";
import { SESSION_COOKIE, readSession, type SessionPayload } from "./session";

/** Server-component helper: the current sealed browser session, or null. */
export async function getSession(nowSeconds?: number): Promise<SessionPayload | null> {
  const config = loadAuthConfig(loadEnv());
  const store = await cookies();
  return readSession(store.get(SESSION_COOKIE)?.value, config.sessionSecret, nowSeconds);
}

/** Validated auth config for server routes/components. Throws AuthConfigError when unset. */
export function requireAuthConfig(): AuthConfig {
  return loadAuthConfig(loadEnv());
}
