import { Card, CardDescription, CardTitle } from "@moneo/ui";
import { getShellIdentity, identityLabel } from "@/lib/shell-identity";

export default async function SettingsPage() {
  const { user, workspace } = await getShellIdentity();

  return (
    <section aria-labelledby="settings-heading" style={{ display: "grid", gap: 16 }}>
      <h1 id="settings-heading" style={{ margin: 0, fontSize: 24 }}>
        Settings
      </h1>
      <Card>
        <CardTitle>Identity</CardTitle>
        {user ? (
          <dl style={{ display: "grid", gap: 4, margin: "8px 0 0" }}>
            <div style={{ display: "flex", gap: 8 }}>
              <dt style={{ fontWeight: 600 }}>User</dt>
              <dd style={{ margin: 0 }} title={user.sub}>
                {identityLabel(user)}
              </dd>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <dt style={{ fontWeight: 600 }}>Workspace</dt>
              <dd style={{ margin: 0 }}>{workspace ? workspace.name : "Setting up…"}</dd>
            </div>
          </dl>
        ) : (
          <CardDescription>
            You are not signed in. <a href="/api/auth/login">Log in</a> to connect your workspace.
          </CardDescription>
        )}
      </Card>
      <Card>
        <CardTitle>Workspace settings</CardTitle>
        <CardDescription>Identity, sessions and preferences arrive from Epoch 1.</CardDescription>
      </Card>
    </section>
  );
}
