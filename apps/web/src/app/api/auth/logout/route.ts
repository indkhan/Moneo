import { loadEnv } from "@moneo/shared/env";
import { NextResponse } from "next/server";
import { loadAuthConfig } from "@/lib/auth-config";
import { buildLogoutRedirect } from "@/lib/auth-flow";

/** GET /api/auth/logout — clear the browser session, then end the IdP session. */
export function GET() {
  const config = loadAuthConfig(loadEnv());
  const { url, clearCookie, clearStateCookie } = buildLogoutRedirect(config);
  const response = NextResponse.redirect(url);
  response.headers.append("Set-Cookie", clearCookie);
  response.headers.append("Set-Cookie", clearStateCookie);
  return response;
}
