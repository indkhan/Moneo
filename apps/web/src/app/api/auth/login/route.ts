import { loadEnv } from "@moneo/shared/env";
import { NextResponse } from "next/server";
import { loadAuthConfig } from "@/lib/auth-config";
import { buildLoginRedirect } from "@/lib/auth-flow";
import { oauthStateSetCookie } from "@/lib/session";

/** GET /api/auth/login — start the Auth0 EU Authorization Code + PKCE flow. */
export function GET() {
  const config = loadAuthConfig(loadEnv());
  const { url, stateSealed } = buildLoginRedirect(config);
  const response = NextResponse.redirect(url);
  response.headers.append("Set-Cookie", oauthStateSetCookie(stateSealed));
  return response;
}
