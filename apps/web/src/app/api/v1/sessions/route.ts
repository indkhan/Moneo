import { getDb } from "@moneo/db/client";
import { listUserSessions } from "@moneo/db/sessions";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-session";

/**
 * GET /api/v1/sessions — the caller's own active sessions, newest first.
 * `current: true` marks the session of the presenting cookie (Issue 1.7).
 */
export async function GET() {
  const session = await getSession();
  if (!session?.uid) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sessions = await listUserSessions(getDb(), session.uid);
  return NextResponse.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      workspaceId: s.workspaceId,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      current: s.id === session.sid,
    })),
  });
}
