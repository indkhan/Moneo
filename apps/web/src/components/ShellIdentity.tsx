import { getShellIdentity, identityLabel } from "@/lib/shell-identity";
import { SignOutButton } from "./SignOutButton";

/**
 * Issue 1.5 — topbar identity cluster (server component).
 * Logged in: user label, workspace name, log out. Logged out: log in.
 */
export async function ShellIdentity() {
  const { user, workspace } = await getShellIdentity();

  if (!user) {
    return (
      <a id="shell-login-mount" href="/auth/login">
        Log in
      </a>
    );
  }

  return (
    <div id="shell-identity-mount" style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span title={user.sub} style={{ fontWeight: 600 }}>
        {identityLabel(user)}
      </span>
      <span aria-label="Current workspace" style={{ opacity: 0.8 }}>
        {workspace ? workspace.name : "Setting up…"}
      </span>
      <SignOutButton />
    </div>
  );
}
