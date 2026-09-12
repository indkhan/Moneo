import { Card, CardDescription, CardTitle, EmptyState } from "@moneo/ui";

export default function HomePage() {
  return (
    <section aria-labelledby="home-heading" style={{ display: "grid", gap: 16 }}>
      <h1 id="home-heading" style={{ margin: 0, fontSize: 24 }}>
        Home
      </h1>
      <Card>
        <CardTitle>Welcome to Moneo</CardTitle>
        <CardDescription>
          Your finance workspace shell. Real dashboard content arrives in Epoch 11.
        </CardDescription>
        <div style={{ marginTop: 12 }}>
          <EmptyState
            title="Nothing to show yet"
            description="Connect accounts and import statements in later epochs."
          />
        </div>
      </Card>
    </section>
  );
}
