import { Card, CardDescription, CardTitle, EmptyState } from "@moneo/ui";

export default function PlanPage() {
  return (
    <section aria-labelledby="plan-heading" style={{ display: "grid", gap: 16 }}>
      <h1 id="plan-heading" style={{ margin: 0, fontSize: 24 }}>
        Plan
      </h1>
      <Card>
        <CardTitle>Forecast & scenarios</CardTitle>
        <CardDescription>Planning intelligence arrives in Epoch 10.</CardDescription>
        <div style={{ marginTop: 12 }}>
          <EmptyState title="No plan yet" description="Goals and forecasts will live here." />
        </div>
      </Card>
    </section>
  );
}
