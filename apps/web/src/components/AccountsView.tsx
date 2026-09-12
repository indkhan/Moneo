"use client";

import * as React from "react";
import { formatMoney } from "@moneo/shared/money";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardDescription, CardTitle, EmptyState, Skeleton } from "@moneo/ui";
import { useMemo, useState } from "react";
import { createClient, type Account } from "../generated/client";
import { RecordBalanceForm } from "./RecordBalanceForm";

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

export function BalanceStateBadge({
  state,
  accountName,
}: {
  state: Account["balanceState"];
  accountName: string;
}) {
  if (state === "ok") {
    return null;
  }
  const label =
    state === "unknown"
      ? "Unknown balance"
      : state === "unreconciled"
        ? "Needs review"
        : "Conflict — record a new balance";
  return (
    <span aria-label={`Balance state for ${accountName}`} style={{ fontSize: 12 }}>
      {label}
    </span>
  );
}

export function AccountsList({
  accounts,
  onRecord,
  recordingId,
  onRecorded,
  onCancelRecord,
}: {
  accounts: Account[];
  onRecord?: (accountId: string) => void;
  recordingId?: string | null;
  onRecorded?: () => void;
  onCancelRecord?: () => void;
}) {
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
                <BalanceStateBadge state={account.balanceState} accountName={account.name} />
              </div>
              <div aria-label={`Balance for ${account.name}`} style={{ fontWeight: 700 }}>
                {formatBalance(account)}
              </div>
            </div>
            {onRecord ? (
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    onRecord(account.id);
                  }}
                >
                  Record balance
                </button>
              </div>
            ) : null}
            {recordingId === account.id && onRecorded && onCancelRecord ? (
              <RecordBalanceForm
                account={account}
                onRecorded={onRecorded}
                onCancel={onCancelRecord}
              />
            ) : null}
          </Card>
        </li>
      ))}
    </ul>
  );
}

export function AccountsView() {
  const client = useMemo(() => createClient(), []);
  const queryClient = useQueryClient();
  const [recordingId, setRecordingId] = useState<string | null>(null);
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
        <button
          type="button"
          onClick={() => {
            void query.refetch();
          }}
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <AccountsList
      accounts={query.data.items}
      onRecord={(accountId) => {
        setRecordingId(accountId);
      }}
      recordingId={recordingId}
      onRecorded={() => {
        setRecordingId(null);
        void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      }}
      onCancelRecord={() => {
        setRecordingId(null);
      }}
    />
  );
}
