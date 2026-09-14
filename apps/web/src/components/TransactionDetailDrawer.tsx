"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
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
        <dt>Category</dt>
        <dd style={{ margin: 0 }}>{detail.categoryName ?? "Uncategorized"}</dd>
        <dt>Merchant</dt>
        <dd style={{ margin: 0 }}>{detail.counterpartyName ?? "Not set"}</dd>
        <dt>Tags</dt>
        <dd style={{ margin: 0 }}>{detail.tags.length ? detail.tags.join(", ") : "None"}</dd>
        <dt>Analytics</dt>
        <dd style={{ margin: 0 }}>
          {detail.excludedFromAnalytics ? "Excluded from analytics" : "Included in analytics"}
        </dd>
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

function TransactionCorrections({
  detail,
  client,
  onChanged,
}: {
  detail: TransactionDetail;
  client: ReturnType<typeof createClient>;
  onChanged: () => void;
}) {
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => client.listCategories() });
  const [merchant, setMerchant] = useState(detail.counterpartyName ?? "");
  const [tags, setTags] = useState(detail.tags.join(", "));
  const [note, setNote] = useState(detail.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<string | null>(null);

  async function run(name: string, input: Record<string, unknown>) {
    setError(null);
    try {
      const result = await client.executeCommand(name, {
        metadata: { idempotencyKey: crypto.randomUUID(), expectedVersion: detail.version },
        input: { transactionId: detail.id, ...input },
      });
      setUndo(result.undoAvailable ? result.operationId : null);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this correction.");
    }
  }

  return (
    <section aria-label="Transaction corrections" style={{ display: "grid", gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>Corrections</h3>
      <label>
        Category{" "}
        <select
          value={detail.categoryId ?? ""}
          disabled={categories.isPending}
          onChange={(event) =>
            void run("transactions.setCategory", { categoryId: event.target.value || null })
          }
        >
          <option value="">Uncategorized</option>
          {(categories.data?.items ?? []).map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Merchant{" "}
        <input
          value={merchant}
          onChange={(event) => {
            setMerchant(event.target.value);
          }}
        />
      </label>
      <button
        type="button"
        onClick={() =>
          void run("transactions.setCounterparty", { counterpartyName: merchant || null })
        }
      >
        Save merchant
      </button>
      <label>
        Tags{" "}
        <input
          value={tags}
          onChange={(event) => {
            setTags(event.target.value);
          }}
          placeholder="Food, travel"
        />
      </label>
      <button
        type="button"
        onClick={() =>
          void run("transactions.addTags", {
            tags: tags
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean),
          })
        }
      >
        Add tags
      </button>
      {detail.tags.map((tag) => (
        <button
          key={tag}
          type="button"
          onClick={() => void run("transactions.removeTags", { tags: [tag] })}
        >
          Remove {tag}
        </button>
      ))}
      <label>
        Note{" "}
        <input
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </label>
      <button
        type="button"
        onClick={() => void run("transactions.setNote", { note: note || null })}
      >
        Save note
      </button>
      <label>
        <input
          type="checkbox"
          checked={detail.excludedFromAnalytics}
          onChange={(event) =>
            void run("transactions.excludeFromAnalytics", { excluded: event.target.checked })
          }
        />{" "}
        Exclude from analytics
      </label>
      {undo ? (
        <button type="button" onClick={() => void run("operations.undo", { operationId: undo })}>
          Undo last change
        </button>
      ) : null}
      {error ? (
        <p role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

function TransactionAuditHistory({ transactionId }: { transactionId: string }) {
  const history = useQuery({
    queryKey: ["transaction", transactionId, "audit"],
    queryFn: async () => {
      const response = await fetch(
        `/api/v1/transactions/${encodeURIComponent(transactionId)}/audit`,
      );
      if (!response.ok) throw new Error("Could not load history.");
      return response.json() as Promise<{
        items: {
          id: string;
          action: string;
          actor: string;
          reason: string | null;
          oldValue: Record<string, unknown> | null;
          newValue: Record<string, unknown> | null;
          createdAt: string;
        }[];
      }>;
    },
  });
  if (history.isPending) return <p>Loading history…</p>;
  if (history.isError) return <p role="alert">Could not load history.</p>;
  return (
    <section aria-label="Audit history">
      <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>History</h3>
      {history.data.items.length === 0 ? (
        <p>No changes yet.</p>
      ) : (
        <ul>
          {history.data.items.map((item) => (
            <li key={item.id}>
              <strong>{item.action}</strong> by {item.actor} ·{" "}
              {new Date(item.createdAt).toLocaleString()}
              <br />
              {item.reason ?? "No reason provided"}
              <details>
                <summary>View change</summary>
                <pre>{JSON.stringify({ from: item.oldValue, to: item.newValue }, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
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
        <>
          <TransactionDetailContent detail={query.data} />
          <TransactionCorrections
            detail={query.data}
            client={client}
            onChanged={() => void query.refetch()}
          />
          <TransactionAuditHistory transactionId={query.data.id} />
        </>
      )}
    </Dialog>
  );
}
