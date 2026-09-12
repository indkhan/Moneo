import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import { findWorkspaceShell, type WorkspaceShell } from "@moneo/db/workspaces";
import { getSession } from "./auth-session";
import type { SessionPayload } from "./auth-session";

/**
 * Issue 1.5 — authenticated shell identity.
 *
 * `resolveShellIdentity` is pure (session in, identity out) so tests cover
 * every state without a database. `getShellIdentity` wires it to the sealed
 * session cookie plus one tenant-scoped workspace lookup — the only query
 * the shell performs, and it goes through `withWorkspaceTransaction`.
 */
export interface ShellUser {
  /** Moneo user id; null for legacy sessions minted before provisioning. */
  id: string | null;
  sub: string;
  email?: string;
  name?: string;
}

export interface ShellIdentity {
  user: ShellUser | null;
  workspace: WorkspaceShell | null;
}

export async function resolveShellIdentity(
  session: SessionPayload | null,
  lookup: (workspaceId: string) => Promise<WorkspaceShell | null>,
): Promise<ShellIdentity> {
  if (!session) {
    return { user: null, workspace: null };
  }
  const user: ShellUser = { id: session.uid ?? null, sub: session.sub };
  if (typeof session.email === "string" && session.email.length > 0) {
    user.email = session.email;
  }
  if (typeof session.name === "string" && session.name.length > 0) {
    user.name = session.name;
  }
  if (typeof session.wid !== "string" || session.wid.length === 0) {
    return { user, workspace: null };
  }
  try {
    return { user, workspace: await lookup(session.wid) };
  } catch (error) {
    // The shell must keep rendering when the database is unreachable.
    console.warn(`Shell workspace lookup failed: ${(error as Error).message}`);
    return { user, workspace: null };
  }
}

/** Display label for the topbar/settings: name → email → raw subject. */
export function identityLabel(user: ShellUser): string {
  return user.name ?? user.email ?? user.sub;
}

export async function getShellIdentity(): Promise<ShellIdentity> {
  let session;
  try {
    session = await getSession();
  } catch (error) {
    // The SDK can be unavailable during a static build or an unconfigured
    // local shell. The surrounding page remains usable as signed out.
    console.warn(`Shell session lookup failed: ${(error as Error).message}`);
    return { user: null, workspace: null };
  }
  return resolveShellIdentity(session, (workspaceId: string) =>
    withWorkspaceTransaction<WorkspaceShell | null>(workspaceId, (tx) => findWorkspaceShell(tx, workspaceId)),
  );
}
