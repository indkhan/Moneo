import { createHash } from "node:crypto";
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

/** Auth0 session ids are opaque strings; the registry stores UUIDs. */
export function sessionRegistryId(providerSessionId: string): string {
  const hex = createHash("sha256").update(providerSessionId, "utf8").digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
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
  const sid = sessionRegistryId(session.internal.sid);
  await registerSession(getDb(), {
    sessionId: sid,
    userId: provisioned.userId,
    workspaceId: provisioned.workspaceId,
  });
  return {
    sub: session.user.sub,
    ...(typeof session.user.email === "string" ? { email: session.user.email } : {}),
    ...(typeof session.user.name === "string" ? { name: session.user.name } : {}),
    uid: provisioned.userId,
    wid: provisioned.workspaceId,
    sid,
    iat: session.internal.createdAt,
    exp: session.internal.sessionExpiresAt ?? Number.MAX_SAFE_INTEGER,
    ...(typeof (session.user as unknown as { auth_time?: unknown }).auth_time === "number"
      ? { authTime: (session.user as unknown as { auth_time: number }).auth_time }
      : {}),
  };
}
