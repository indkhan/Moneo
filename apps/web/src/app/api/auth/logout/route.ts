import { getDb } from "@moneo/db/client";
import { revokeUserSessions } from "@moneo/db/sessions";
import { loadEnv } from "@moneo/shared/env";
import { NextResponse } from "next/server";
import { loadAuthConfig } from "@/lib/auth-config";
import { buildLogoutRedirect } from "@/lib/auth-flow";
import { getSession } from "@/lib/auth-session";
import { oauthStateClearCookie, sessionClearCookie } from "@/lib/session";

/**
 * POST /api/auth/logout — revoke the server-side session, clear the browser
 * cookies, and hand the client the federated Auth0 logout URL (Issue 1.7).
 *
 * Sign-out is a POST because it mutates server state; the edge middleware's
 * CSRF gate applies. GET is intentionally gone (405): a plain link must not
 * be able to burn sessions.
 */
export async function POST() {
  const config = loadAuthConfig(loadEnv());
  const session = await getSession();
  if (session?.uid) {
    try {
      await revokeUserSessions(getDb(), session.uid, null);
    } catch {
      // Best effort: clearing the browser cookies below still signs out
      // this device even if the registry write lost a race.
    }
  }
  const { url } = buildLogoutRedirect(config);
  const response = NextResponse.json({ loggedOut: true, federatedLogoutUrl: url });
  response.headers.append("Set-Cookie", sessionClearCookie());
  response.headers.append("Set-Cookie", oauthStateClearCookie());
  return response;
}
