import { sql } from "drizzle-orm";
import { type ProvisionExecutor } from "./provisioning.js";
import { assertUuid } from "./uuid.js";

/**
 * Issue 1.7 — server-side session registry client.
 *
 * Revocation only means something if the server tracks sessions, so every
 * login registers its sealed-cookie `sid` here (callback route) and every
 * sign-out revokes through here. All access funnels through DEFINER
 * functions keyed by the sealed-cookie user id — the app role has no direct
 * session reads, so one user can never list another's sessions.
 */
export interface SessionRecord {
  id: string;
  workspaceId: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}

export interface RegisterSessionInput {
  sessionId: string;
  userId: string;
  workspaceId: string;
  userAgent?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowsOf(raw: unknown, what: string): Record<string, unknown>[] {
  const rows: unknown = isRecord(raw) && Array.isArray(raw.rows) ? raw.rows : raw;
  if (!Array.isArray(rows) || !rows.every(isRecord)) {
    throw new Error(`Session registry returned an unexpected shape (${what})`);
  }
  return rows;
}

function asDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? value : new Date(typeof value === "string" ? value : NaN);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Session registry returned an unexpected shape (bad ${field})`);
  }
  return date;
}

/** Record a login. Throws when the user is not a member of the workspace. */
export async function registerSession(
  db: ProvisionExecutor,
  input: RegisterSessionInput,
): Promise<void> {
  const sessionId = assertUuid(input.sessionId, "sessionId");
  const userId = assertUuid(input.userId, "userId");
  const workspaceId = assertUuid(input.workspaceId, "workspaceId");
  const userAgent = input.userAgent === undefined ? null : input.userAgent.slice(0, 500);
  await db.execute(
    sql`SELECT register_session(${sessionId}::uuid, ${userId}::uuid, ${workspaceId}::uuid, ${userAgent})`,
  );
}

/** Active sessions for the caller, newest first. Never another user's. */
export async function listUserSessions(
  db: ProvisionExecutor,
  userId: string,
): Promise<SessionRecord[]> {
  const id = assertUuid(userId, "userId");
  const raw: unknown = await db.execute(sql`SELECT * FROM list_user_sessions(${id}::uuid)`);
  return rowsOf(raw, "list").map((row) => {
    if (typeof row.session_id !== "string") {
      throw new Error("Session registry returned an unexpected shape (bad session_id)");
    }
    if (row.workspace_id !== null && typeof row.workspace_id !== "string") {
      throw new Error("Session registry returned an unexpected shape (bad workspace_id)");
    }
    if (row.user_agent !== null && typeof row.user_agent !== "string") {
      throw new Error("Session registry returned an unexpected shape (bad user_agent)");
    }
    return {
      id: row.session_id,
      workspaceId: row.workspace_id,
      userAgent: row.user_agent,
      createdAt: asDate(row.created_at, "created_at"),
      lastSeenAt: asDate(row.last_seen_at, "last_seen_at"),
    };
  });
}

/**
 * Revoke the caller's sessions. `keepSessionId` null revokes everything
 * (full sign-out); otherwise that session survives. Returns the revoked count.
 */
export async function revokeUserSessions(
  db: ProvisionExecutor,
  userId: string,
  keepSessionId: string | null,
): Promise<number> {
  const id = assertUuid(userId, "userId");
  const keep = keepSessionId === null ? null : assertUuid(keepSessionId, "keepSessionId");
  const raw: unknown = await db.execute(
    sql`SELECT revoke_user_sessions(${id}::uuid, ${keep}::uuid) AS revoked`,
  );
  return revokedCount(raw);
}

/** Revoke exactly one owned session. Returns 1 when something was revoked. */
export async function revokeSingleSession(
  db: ProvisionExecutor,
  userId: string,
  sessionId: string,
): Promise<number> {
  const id = assertUuid(userId, "userId");
  const target = assertUuid(sessionId, "sessionId");
  const raw: unknown = await db.execute(
    sql`SELECT revoke_user_sessions(${id}::uuid, NULL, ${target}::uuid) AS revoked`,
  );
  return revokedCount(raw);
}

function revokedCount(raw: unknown): number {
  const rows = rowsOf(raw, "revoke");
  const revoked: unknown = rows[0]?.revoked;
  if (typeof revoked !== "number") {
    throw new Error("Session registry returned an unexpected shape (bad revoked count)");
  }
  return revoked;
}
