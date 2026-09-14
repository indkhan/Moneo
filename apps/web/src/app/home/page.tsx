import { Card, CardDescription, CardTitle } from "@moneo/ui";
import Link from "next/link";

export default function HomePage() {
  return (
    <section aria-labelledby="home-heading" style={{ display: "grid", gap: 16 }}>
      <h1 id="home-heading" style={{ margin: 0, fontSize: 24 }}>
        Home
      </h1>
      <Card>
        <CardTitle>Welcome to Moneo</CardTitle>
        <CardDescription>
          Bring your accounts and transactions together, then ask questions about your finances.
        </CardDescription>
        <div style={{ marginTop: 12 }}>
          <ul>
            <li>
              <Link href="/money/import">Import a CSV or Excel statement</Link>
            </li>
            <li>
              <Link href="/money/accounts">Manage accounts and balances</Link>
            </li>
            <li>
              <Link href="/money/transactions">Review and correct transactions</Link>
            </li>
            <li>
              <Link href="/ai">Ask the finance assistant</Link>
            </li>
          </ul>
        </div>
      </Card>
    </section>
  );
}
