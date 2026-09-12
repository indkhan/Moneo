"use client";

import * as React from "react";
import { formatMoney } from "@moneo/shared/money";
import { useQuery } from "@tanstack/react-query";
import { Card, CardDescription, CardTitle, EmptyState, Skeleton } from "@moneo/ui";
import { useMemo } from "react";
import { createClient, type Account } from "../generated/client";

/**
 * Issue 4.7 — Money → Accounts.
 *
 * One `useQuery` over the GENERATED client (`GET /accounts`): server-side
 * source of truth, no local balance math. Unknown balances render as
 * "Unknown" — the null survives from the query layer to this line, never
 * coerced to zero.
 */

export function formatBalance(account: Account): string {
  const balance = account.balance;
  if (!balance || balance.currentAmountMinor === null) {
    return "Unknown";
  }
  return formatMoney(
    {
      amountMinor: BigInt(balance.currentAmountMinor),
      currency: balance.currencyCode,
      direction: "credit",
    },
    "en-GB",
  );
}

export function AccountsList({ accounts }: { accounts: Account[] }) {
  if (accounts.length === 0) {
    return <EmptyState title="No accounts yet" description="Import a statement to get started." />;
  }
  return (
    <ul aria-label="Accounts" style={{ display: "grid", gap: 12, margin: 0, padding: 0 }}>
      {accounts.map((account) => (
        <li key={account.id} style={{ listStyle: "none" }}>
          <Card>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                alignItems: "baseline",
              }}
            >
              <div>
                <CardTitle>{account.name}</CardTitle>
                <CardDescription>
                  {account.accountType} · {account.currencyCode}
                  {account.archivedAt ? " · archived" : ""}
                </CardDescription>
              </div>
              <div aria-label={`Balance for ${account.name}`} style={{ fontWeight: 700 }}>
                {formatBalance(account)}
              </div>
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}

export function AccountsView() {
  const client = useMemo(() => createClient(), []);
  const query = useQuery({
    queryKey: ["accounts"],
    queryFn: () => client.listAccounts(),
  });

  if (query.isPending) {
    return (
      <div aria-label="Loading accounts" style={{ display: "grid", gap: 12 }}>
        <Skeleton style={{ height: 72 }} />
        <Skeleton style={{ height: 72 }} />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div role="alert">
        <p>Could not load accounts.</p>
        <button type="button" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    );
  }
  return <AccountsList accounts={query.data.items} />;
}
