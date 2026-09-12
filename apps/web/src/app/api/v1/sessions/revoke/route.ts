import { getDb } from "@moneo/db/client";
import { revokeSingleSession, revokeUserSessions } from "@moneo/db/sessions";
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth-session";

/**
 * POST /api/v1/sessions/revoke — sign out sessions (Issue 1.7).
 *
 * Body: `{ "sessionId": "<sid>" }` revokes exactly that owned session,
 * `{ "allOthers": true }` revokes everything except the caller's own.
 * A mutation, so the edge middleware's CSRF gate applies.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.uid) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const { sessionId, allOthers } = body as { sessionId?: unknown; allOthers?: unknown };
  try {
    if (allOthers === true) {
      const revoked = await revokeUserSessions(getDb(), session.uid, session.sid);
      return NextResponse.json({ revoked });
    }
    if (typeof sessionId === "string" && sessionId.length > 0) {
      const revoked = await revokeSingleSession(getDb(), session.uid, sessionId);
      return NextResponse.json({ revoked });
    }
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  return NextResponse.json({ error: "invalid_request" }, { status: 400 });
}
