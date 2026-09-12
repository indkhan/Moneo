"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Dialog } from "@moneo/ui";
import { Skeleton } from "@moneo/ui";
import { createClient, type TransactionDetail } from "../generated/client";
import { formatTransactionAmount } from "./TransactionsView";

/**
 * Issue 4.8 — transaction detail drawer.
 *
 * Canonical fields first, then source/import provenance, then "View
 * original" with the verbatim raw payload. The drawer is an overlay: the
 * list behind it never unmounts, so list position and filters survive
 * opening and closing. Content is a pure component for static-markup
 * tests; only the container fetches (Radix Dialog owns focus + Escape).
 */

export function TransactionDetailContent({ detail }: { detail: TransactionDetail }) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <dl
        aria-label="Canonical transaction fields"
        style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: 0 }}
      >
        <dt>Description</dt>
        <dd style={{ margin: 0, fontWeight: 700 }}>{detail.description}</dd>
        <dt>Date</dt>
        <dd style={{ margin: 0 }}>{detail.effectiveDate}</dd>
        <dt>Account</dt>
        <dd style={{ margin: 0 }}>{detail.accountName}</dd>
        <dt>Direction</dt>
        <dd style={{ margin: 0 }}>{detail.direction}</dd>
        <dt>Amount</dt>
        <dd style={{ margin: 0 }}>{formatTransactionAmount(detail)}</dd>
        <dt>Status</dt>
        <dd style={{ margin: 0 }}>{detail.status}</dd>
      </dl>
      <section aria-label="Source and import">
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>Source & import</h3>
        {detail.sources.length === 0 ? (
          <p style={{ margin: 0 }}>Manually recorded — no imported source.</p>
        ) : (
          <ul style={{ display: "grid", gap: 12, margin: 0, padding: 0 }}>
            {detail.sources.map((source, index) => (
              <li key={`${source.sourceTransactionId}-${index}`} style={{ listStyle: "none" }}>
                <p style={{ margin: 0 }}>
                  {source.dataSourceName}
                  {source.fileName ? ` · ${source.fileName}` : ""} · {source.relationship}
                </p>
                <details>
                  <summary>View original</summary>
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
                    {JSON.stringify(source.rawPayload, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function TransactionDetailDrawer({
  transactionId,
  onClose,
}: {
  transactionId: string;
  onClose: () => void;
}) {
  const client = useMemo(() => createClient(), []);
  const query = useQuery({
    queryKey: ["transaction", transactionId],
    queryFn: () => client.getTransaction(transactionId),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      title="Transaction detail"
    >
      {query.isPending ? (
        <div aria-label="Loading transaction detail" style={{ display: "grid", gap: 8 }}>
          <Skeleton style={{ height: 20 }} />
          <Skeleton style={{ height: 20 }} />
        </div>
      ) : query.isError ? (
        <div role="alert">
          <p>Could not load this transaction.</p>
          <button
            type="button"
            onClick={() => {
              void query.refetch();
            }}
          >
            Retry
          </button>
        </div>
      ) : (
        <TransactionDetailContent detail={query.data} />
      )}
    </Dialog>
  );
}
