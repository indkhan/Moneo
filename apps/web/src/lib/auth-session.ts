import { auth0 } from "./auth0";
import { getDb } from "@moneo/db/client";
import { provisionUserOnLogin } from "@moneo/db/provisioning";
import { registerSession } from "@moneo/db/sessions";

export interface SessionPayload {
  sub: string;
  email?: string;
  name?: string;
  uid?: string;
  wid?: string;
  sid: string;
  iat: number;
  exp: number;
  /** OIDC auth_time: when the provider last authenticated the user. */
  authTime?: number;
}

/** Server-component helper: the current sealed browser session, or null. */
export async function getSession(_nowSeconds?: number): Promise<SessionPayload | null> {
  const session = await auth0.getSession();
  if (!session) return null;
  const provisioned = await provisionUserOnLogin(getDb(), {
    authSubject: session.user.sub,
    email: session.user.email,
    displayName: session.user.name,
  });
  await registerSession(getDb(), {
    sessionId: session.internal.sid,
    userId: provisioned.userId,
    workspaceId: provisioned.workspaceId,
  });
  return {
    sub: session.user.sub,
    ...(typeof session.user.email === "string" ? { email: session.user.email } : {}),
    ...(typeof session.user.name === "string" ? { name: session.user.name } : {}),
    uid: provisioned.userId,
    wid: provisioned.workspaceId,
    sid: session.internal.sid,
    iat: session.internal.createdAt,
    exp: session.internal.sessionExpiresAt ?? Number.MAX_SAFE_INTEGER,
    ...(typeof (session.user as unknown as { auth_time?: unknown }).auth_time === "number"
      ? { authTime: (session.user as unknown as { auth_time: number }).auth_time }
      : {}),
  };
}
