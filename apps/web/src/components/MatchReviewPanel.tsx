"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import { createClient, type MatchCandidate, type MoneoClient } from "../generated/client";

/**
 * Issue 4.11 — minimal match review UI for the import summary step.
 *
 * Self-fetching (plain fetch state, no query provider needed): lists staged
 * `pending` rows with both sides' descriptions and offers link-to-existing
 * / keep-as-distinct through the audited `matches.resolve` command. E7
 * reuses the same rows and commands in the Review inbox.
 */

export function MatchReviewList({
  items,
  resolvingId,
  onResolve,
}: {
  items: MatchCandidate[];
  resolvingId: string | null;
  onResolve: (candidateId: string, decision: "link" | "distinct") => void;
}) {
  if (items.length === 0) {
    return <p role="status">No rows need review — every row resolved cleanly.</p>;
  }
  return (
    <ul
      aria-label="Rows needing review"
      style={{ display: "grid", gap: 12, margin: 0, padding: 0 }}
    >
      {items.map((item) => (
        <li
          key={item.id}
          style={{ listStyle: "none", border: "1px solid #2a3442", borderRadius: 8, padding: 12 }}
        >
          <p style={{ margin: "0 0 4px", fontWeight: 700 }}>{item.stagedDescription}</p>
          <p style={{ margin: "0 0 8px", fontSize: 13 }}>
            {`New row from this import looks like “${item.candidateDescription}” (${item.candidateDate}). Link them, or keep both.`}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              disabled={resolvingId === item.id}
              onClick={() => {
                onResolve(item.id, "link");
              }}
            >
              Link to existing
            </button>
            <button
              type="button"
              disabled={resolvingId === item.id}
              onClick={() => {
                onResolve(item.id, "distinct");
              }}
            >
              Keep distinct
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function MatchReviewPanel({ importId, client }: { importId: string; client?: MoneoClient }) {
  const api = React.useMemo(() => client ?? createClient(), [client]);
  const [items, setItems] = useState<MatchCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const refresh = React.useCallback(() => {
    api
      .listPendingMatches(importId)
      .then((page) => {
        setItems(page.items);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not load review rows.");
      });
  }, [api, importId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function resolve(candidateId: string, decision: "link" | "distinct") {
    setResolvingId(candidateId);
    try {
      await api.executeCommand("matches.resolve", {
        metadata: { idempotencyKey: crypto.randomUUID() },
        input: { candidateId, decision },
      });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resolve the row.");
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <section aria-labelledby="match-review-heading" style={{ display: "grid", gap: 8 }}>
      <h3 id="match-review-heading" style={{ margin: 0, fontSize: 15 }}>
        Rows needing review
      </h3>
      {error ? (
        <p role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
      {items === null ? (
        <p aria-label="Loading review rows">Loading review rows…</p>
      ) : (
        <MatchReviewList
          items={items}
          resolvingId={resolvingId}
          onResolve={(candidateId, decision) => {
            void resolve(candidateId, decision);
          }}
        />
      )}
    </section>
  );
}
