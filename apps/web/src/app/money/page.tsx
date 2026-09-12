import Link from "next/link";
import { Card, CardDescription, CardTitle } from "@moneo/ui";
import { MoneyOverview } from "@/components/MoneyOverview";

/**
 * Issue 4.7 — Money → Overview (minimal): live account summary plus
 * explicit navigation to Accounts and Transactions. Canonical browsing
 * (cursor pages, server-side filter/sort) lives on the subpages.
 */
export default function MoneyPage() {
  return (
    <section aria-labelledby="money-heading" style={{ display: "grid", gap: 16 }}>
      <h1 id="money-heading" style={{ margin: 0, fontSize: 24 }}>
        Money
      </h1>
      <Card>
        <CardTitle>Overview</CardTitle>
        <div style={{ marginTop: 8 }}>
          <MoneyOverview />
        </div>
      </Card>
      <Card>
        <CardTitle>
          <Link href="/money/accounts">Accounts</Link>
        </CardTitle>
        <CardDescription>Canonical accounts with the latest known balance.</CardDescription>
      </Card>
      <Card>
        <CardTitle>
          <Link href="/money/transactions">Transactions</Link>
        </CardTitle>
        <CardDescription>
          Canonical transactions with server-side search, sort, and cursor pages.
        </CardDescription>
      </Card>
    </section>
  );
}
