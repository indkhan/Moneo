import { getDb } from "@moneo/db/client";
import { listUserSessions } from "@moneo/db/sessions";
import { Card, CardDescription, CardTitle } from "@moneo/ui";
import { SessionSecurity } from "@/components/SessionSecurity";
import { StrongAuthSection } from "@/components/StrongAuthSection";
import { AiSettings } from "@/components/AiSettings";
import { getSession } from "@/lib/auth-session";
import { getShellIdentity, identityLabel } from "@/lib/shell-identity";
import type { SessionListItem } from "@/lib/sessions-client";
import type { StrongAuthStatusBody } from "@/lib/strong-auth-client";
import { providerFromEnv, resolveStrongAuthStatus } from "@/lib/strong-auth";

export default async function SettingsPage() {
  const { user, workspace } = await getShellIdentity();

  let initialSessions: SessionListItem[] = [];
  if (user?.id) {
    const rawSession = await getSession();
    const sessions = await listUserSessions(getDb(), user.id);
    initialSessions = sessions.map((s) => ({
      id: s.id,
      workspaceId: s.workspaceId,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      current: rawSession !== null && s.id === rawSession.sid,
    }));
  }

  let initialStrongAuth: StrongAuthStatusBody = {
    state: "signed-out",
    method: null,
    factors: [],
    passkeysOffered: true,
  };
  if (user?.id) {
    try {
      const status = await resolveStrongAuthStatus(providerFromEnv());
      initialStrongAuth = {
        state: status.state,
        method: status.method,
        factors: status.factors.map((f) => ({
          id: f.id,
          kind: f.kind,
          providerType: f.providerType,
          confirmed: f.confirmed,
        })),
        passkeysOffered: status.passkeysOffered,
      };
    } catch {
      initialStrongAuth = { state: "degraded", method: null, factors: [], passkeysOffered: true };
    }
  }

  return (
    <section aria-labelledby="settings-heading" style={{ display: "grid", gap: 16 }}>
      <h1 id="settings-heading" style={{ margin: 0, fontSize: 24 }}>
        Settings
      </h1>
      <AiSettings />
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
            You are not signed in. <a href="/auth/login">Log in</a> to connect your workspace.
          </CardDescription>
        )}
      </Card>
      <Card>
        <CardTitle>Privacy &amp; Security</CardTitle>
        {user ? (
          <SessionSecurity initialSessions={initialSessions} />
        ) : (
          <CardDescription>
            Sign in to review and revoke your sessions. <a href="/auth/login">Log in</a>
          </CardDescription>
        )}
      </Card>
      <Card>
        <CardTitle>Strong authentication</CardTitle>
        {user ? (
          <StrongAuthSection initialStatus={initialStrongAuth} />
        ) : (
          <CardDescription>
            Passkeys or an authenticator app unlock finance access after you sign in.{" "}
            <a href="/auth/login">Log in</a>
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
