import { sql } from "drizzle-orm";
import { type ProvisionExecutor } from "./provisioning.js";
import { assertUuid } from "./uuid.js";

/**
 * Issue 1.5 — workspace reads for the authenticated shell.
 *
 * Runs INSIDE `withWorkspaceTransaction`, so the `workspaces_isolation`
 * policy filters to the caller's workspace; anything else resolves null.
 * Plain SQL over the shared executor surface keeps this callable from any
 * drizzle PG client (pooled node-postgres, transactions, PGlite).
 */
export interface WorkspaceShell {
  id: string;
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function findWorkspaceShell(
  db: ProvisionExecutor,
  workspaceId: string,
): Promise<WorkspaceShell | null> {
  const id = assertUuid(workspaceId, "workspaceId");
  const raw: unknown = await db.execute(
    sql`SELECT id, name FROM workspaces WHERE id = ${id} LIMIT 1`,
  );
  const rows: unknown = isRecord(raw) && Array.isArray(raw.rows) ? raw.rows : raw;
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  const row: unknown = rows[0];
  if (!isRecord(row) || typeof row.id !== "string" || typeof row.name !== "string") {
    throw new Error("Workspace lookup returned an unexpected shape");
  }
  return { id: row.id, name: row.name };
}

/** Whether the authenticated member is an owner of the current workspace. */
export async function isWorkspaceOwner(
  db: ProvisionExecutor,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const workspace = assertUuid(workspaceId, "workspaceId");
  const user = assertUuid(userId, "userId");
  const raw: unknown = await db.execute(sql`
    SELECT role FROM workspace_members
    WHERE workspace_id = ${workspace} AND user_id = ${user}
    LIMIT 1
  `);
  const rows: unknown = isRecord(raw) && Array.isArray(raw.rows) ? raw.rows : raw;
  return Array.isArray(rows) && isRecord(rows[0]) && rows[0].role === "OWNER";
}
