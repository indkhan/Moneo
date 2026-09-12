import { Card, CardDescription, CardTitle } from "@moneo/ui";

export default function SettingsPage() {
  return (
    <section aria-labelledby="settings-heading" style={{ display: "grid", gap: 16 }}>
      <h1 id="settings-heading" style={{ margin: 0, fontSize: 24 }}>
        Settings
      </h1>
      <Card>
        <CardTitle>Workspace settings</CardTitle>
        <CardDescription>Identity, sessions and preferences arrive from Epoch 1.</CardDescription>
      </Card>
    </section>
  );
}
