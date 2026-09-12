import { Card, CardDescription, CardTitle, EmptyState } from "@moneo/ui";

export default function AiPage() {
  return (
    <section aria-labelledby="ai-heading" style={{ display: "grid", gap: 16 }}>
      <h1 id="ai-heading" style={{ margin: 0, fontSize: 24 }}>
        AI
      </h1>
      <Card>
        <CardTitle>Finance assistant</CardTitle>
        <CardDescription>Grounded chat arrives in Epoch 6.</CardDescription>
        <div style={{ marginTop: 12 }}>
          <EmptyState title="Assistant offline" description="Threads will appear here." />
        </div>
      </Card>
    </section>
  );
}
