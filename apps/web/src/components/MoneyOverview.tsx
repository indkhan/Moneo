"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { createClient } from "../generated/client";

/**
 * Issue 4.7 — Money → Overview (minimal).
 *
 * Live counts only; every number comes from `GET /accounts`, never from
 * local math. Accounts without a snapshot count as unknown — the overview
 * says so instead of showing a zero total.
 */
export function MoneyOverview() {
  const client = useMemo(() => createClient(), []);
  const query = useQuery({ queryKey: ["accounts"], queryFn: () => client.listAccounts() });

  if (query.isPending) {
    return <p aria-label="Loading overview">Loading overview…</p>;
  }
  if (query.isError) {
    return (
      <div role="alert">
        <p>Could not load the overview.</p>
        <button type="button" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    );
  }
  const unknown = query.data.items.filter((a) => a.balance === null).length;
  return (
    <p aria-live="polite" style={{ margin: 0 }}>
      {query.data.items.length} {query.data.items.length === 1 ? "account" : "accounts"}
      {unknown > 0
        ? ` · ${unknown} with unknown balance (add a statement balance to complete the picture)`
        : " · all balances known"}
    </p>
  );
}
