import { Card, CardDescription, CardTitle, EmptyState } from "@moneo/ui";

export default function MoneyPage() {
  return (
    <section aria-labelledby="money-heading" style={{ display: "grid", gap: 16 }}>
      <h1 id="money-heading" style={{ margin: 0, fontSize: 24 }}>
        Money
      </h1>
      <Card>
        <CardTitle>Accounts & transactions</CardTitle>
        <CardDescription>Canonical money screens arrive in Epoch 4.</CardDescription>
        <div style={{ marginTop: 12 }}>
          <EmptyState title="No accounts yet" description="Import a statement to get started." />
        </div>
      </Card>
    </section>
  );
}
