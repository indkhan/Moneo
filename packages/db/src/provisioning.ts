import { sql, type SQL } from "drizzle-orm";
import { assertUuid, uuidv7 } from "./uuid.js";

/**
 * Epoch 1, Issue 1.4 — first-login provisioning.
 *
 * `Auth0 subject → users row → default workspace → OWNER membership`,
 * executed by the `provision_user_on_login` SECURITY DEFINER function so the
 * app role never needs broad user-table reads (see migration `0003`). Fully
 * idempotent: repeats return the same ids, concurrent first-logins serialize
 * on a per-subject advisory lock.
 */
export const PROVISION_FUNCTION = "provision_user_on_login";

const MAX_LENGTHS = {
  authSubject: 256,
  email: 320,
  displayName: 200,
  workspaceName: 100,
} as const;

export interface ProvisioningInput {
  authSubject: string;
  email?: string;
  displayName?: string;
  workspaceName?: string;
  /** Fresh UUIDv7 minted by the caller when creating; defaults to `uuidv7()`. */
  userId?: string;
  workspaceId?: string;
}

export interface ProvisioningResult {
  userId: string;
  workspaceId: string;
  createdUser: boolean;
  createdWorkspace: boolean;
}

function checkLength(value: string | undefined, max: number, label: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (value.length > max) {
    throw new Error(`Invalid ${label}: longer than ${max} characters`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Minimal query surface provisioning needs. Any drizzle PG client (pooled
 * node-postgres, transactions, PGlite) satisfies it structurally.
 */
export interface ProvisionExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

/**
 * Provision (or re-resolve) the caller. `db` is any drizzle client on the
 * app-role pool — no elevated connection needed.
 */
export async function provisionUserOnLogin(
  db: ProvisionExecutor,
  input: ProvisioningInput,
): Promise<ProvisioningResult> {
  const authSubject = input.authSubject;
  if (typeof authSubject !== "string" || authSubject.length === 0 || authSubject.length > MAX_LENGTHS.authSubject) {
    throw new Error("Invalid authSubject: must be 1-256 characters");
  }
  const email = checkLength(input.email, MAX_LENGTHS.email, "email");
  const displayName = checkLength(input.displayName, MAX_LENGTHS.displayName, "displayName");
  const workspaceName = checkLength(input.workspaceName, MAX_LENGTHS.workspaceName, "workspaceName");
  const userId = assertUuid(input.userId ?? uuidv7(), "userId");
  const workspaceId = assertUuid(input.workspaceId ?? uuidv7(), "workspaceId");

  const raw: unknown = await db.execute(
    sql`SELECT * FROM ${sql.raw(PROVISION_FUNCTION)}(${authSubject}, ${email}, ${displayName}, ${workspaceName}, ${userId}::uuid, ${workspaceId}::uuid)`,
  );
  const rows: unknown = isRecord(raw) && Array.isArray(raw.rows) ? raw.rows : raw;
  if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])) {
    throw new Error("Provisioning returned an unexpected shape");
  }
  const row = rows[0];
  if (
    typeof row.user_id !== "string" ||
    typeof row.workspace_id !== "string" ||
    typeof row.created_user !== "boolean" ||
    typeof row.created_workspace !== "boolean"
  ) {
    throw new Error("Provisioning returned an unexpected shape");
  }
  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    createdUser: row.created_user,
    createdWorkspace: row.created_workspace,
  };
}
