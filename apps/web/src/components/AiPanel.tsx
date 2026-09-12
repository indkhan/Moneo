"use client";

import { Card, CardDescription, CardTitle, EmptyState } from "@moneo/ui";

/** Persistent AI side panel mount. Epoch 0: shell only, no assistant yet. */
export function AiPanel() {
  return (
    <aside
      id="ai-panel-mount"
      aria-label="AI assistant panel"
      style={{ padding: 12, height: "100%", overflow: "auto" }}
    >
      <Card>
        <CardTitle>Assistant</CardTitle>
        <CardDescription>Grounded finance chat arrives in Epoch 6.</CardDescription>
        <div style={{ marginTop: 12 }}>
          <EmptyState
            title="No conversation yet"
            description="The persistent AI panel lives here on every route."
          />
        </div>
      </Card>
    </aside>
  );
}
