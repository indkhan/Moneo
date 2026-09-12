import { getDb } from "@moneo/db/client";
import { provisionUserOnLogin } from "@moneo/db/provisioning";
import { registerSession } from "@moneo/db/sessions";
import { loadEnv } from "@moneo/shared/env";
import { NextResponse, type NextRequest } from "next/server";
import { loadAuthConfig, tokenEndpoint, userinfoEndpoint } from "@/lib/auth-config";
import { completeLogin, type CodeExchange, type UserProfile } from "@/lib/auth-flow";
import { OAUTH_STATE_COOKIE, oauthStateClearCookie, sessionSetCookie } from "@/lib/session";

/** GET /api/auth/callback — Auth0 EU redirects here; tokens stay server-side. */
export async function GET(request: NextRequest) {
  const config = loadAuthConfig(loadEnv());
  const url = new URL(request.url);

  if (url.searchParams.get("error")) {
    const denied = NextResponse.redirect(new URL("/?auth_error=invalid_request", config.baseUrl));
    denied.headers.append("Set-Cookie", oauthStateClearCookie());
    return denied;
  }

  const result = await completeLogin({
    config,
    queryState: url.searchParams.get("state"),
    queryCode: url.searchParams.get("code"),
    stateCookie: request.cookies.get(OAUTH_STATE_COOKIE)?.value,
    userAgent: request.headers.get("user-agent"),
    exchange: async (
      code: string,
      verifier: string,
      redirectUri: string,
    ): Promise<CodeExchange> => {
      const res = await fetch(tokenEndpoint(config), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
      });
      if (!res.ok) {
        throw new Error(`Token exchange failed with status ${res.status}`);
      }
      return (await res.json()) as CodeExchange;
    },
    fetchProfile: async (accessToken: string): Promise<UserProfile> => {
      const res = await fetch(userinfoEndpoint(config), {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        throw new Error(`Userinfo fetch failed with status ${res.status}`);
      }
      return (await res.json()) as UserProfile;
    },
    // Issue 1.4: first successful login provisions user + default workspace.
    provision: async (profile: UserProfile) => {
      const provisioned = await provisionUserOnLogin(getDb(), {
        authSubject: profile.sub,
        email: typeof profile.email === "string" ? profile.email : undefined,
        displayName: typeof profile.name === "string" ? profile.name : undefined,
      });
      return { uid: provisioned.userId, wid: provisioned.workspaceId };
    },
    // Issue 1.7: persist the login so Settings can list and revoke it.
    registerSession: async ({ sid, uid, wid, userAgent }) => {
      await registerSession(getDb(), {
        sessionId: sid,
        userId: uid,
        workspaceId: wid,
        userAgent: userAgent ?? undefined,
      });
    },
  });

  if (!result.ok) {
    const failed = NextResponse.redirect(new URL(result.redirectTo, config.baseUrl));
    failed.headers.append("Set-Cookie", oauthStateClearCookie());
    return failed;
  }
  const done = NextResponse.redirect(new URL(result.redirectTo, config.baseUrl));
  done.headers.append("Set-Cookie", sessionSetCookie(result.sessionSealed));
  done.headers.append("Set-Cookie", oauthStateClearCookie());
  return done;
}
